/**
 * Transport for the publication/taxonomy/context/evidence kernels (#31).
 *
 * The measured constraint this file exists to preserve: every method in
 * `registry.ts` runs a governed strict parser over raw BYTES with a 1 MiB
 * limit, depth 64, duplicate-key rejection and valid-UTF-8 enforcement. A
 * transport that JSON-parses before handing bytes to the facade silently
 * destroys two of those guarantees (`JSON.parse` is last-wins on duplicate
 * keys, and a size check after parsing is not a byte limit). So: the ORIGINAL
 * `Uint8Array` read off the wire is the exact same object handed to
 * `KnowledgeMethod.call`, never re-encoded, never re-serialized.
 *
 * Scope handling mirrors the existing `POST /api/memories` precedent in
 * `app.ts`: the route's `:bank` segment is the authoritative, admitted
 * workspace. Because several of these methods carry `workspace_name` inside
 * the body (the admission layer for #25 never anticipated a body-scoped
 * kernel with this many entrypoints), the body is peeked with the SAME
 * governed parser used everywhere else in this package, purely to check that
 * its `workspace_name` equals the admitted route bank. A caller naming a
 * DIFFERENT workspace in the body than the one admitted in the URL is a bad
 * request, not a bypass: "names in requests are NOT authorization" (per the
 * task brief) means the ROUTE bank decides the grant, and the body is only
 * trusted once it agrees with it. The original bytes are still what reaches
 * the service — the peek discards its own parse result immediately after
 * the comparison.
 *
 * Writer ownership (#31 constraint 3): this combined HTTP+MCP process is the
 * SOLE writer of the configured `ARRA_KNOWLEDGE_DATASET_ROOT`. The writer
 * bundle is opened LAZILY, on the first accepted write request, and cached
 * for the lifetime of the process — never reopened per request, and never
 * closed by a route handler, because closing mid-serve would release the
 * fd-42 flock while other requests still believe they hold it. Any other
 * process that needs this dataset (a CLI invocation, a second server
 * instance, a test) must not run concurrently in writer mode; it may always
 * open `openKnowledgeReader` / `openEvidenceReader`, which take no gate at
 * all. A future CLI writer must be started only while this server is stopped,
 * or must be pointed at a different dataset root.
 *
 * Chat (#32 slice A, overnight ruling R9): `answerChat` persists nothing, so
 * it runs on the READER bundle's `chat` facade, composed here with the
 * configured model. No request path opens, closes or releases a writer --
 * the per-request "ephemeral writer" that chat used to take is gone, because
 * in one gated process it both contended for the single owner slot and, on
 * close, released the process's only inherited writer gate.
 */

import { randomBytes } from "node:crypto";
import {
  checkBodyEncoding,
  errorResponse,
  isValidWorkspace,
  readAuthorization,
  type TransportRejection,
} from "../auth/http";
import { ContractError } from "../contracts/errors";
import { parseStrictBytes, type JcsObject, type JcsValue } from "../contracts/jcs";
import type { ChatModelFn, ChatSettings } from "../publication/chat";
import { type DigestProbeFn, type EmbedFn } from "../publication/search-chunk.types";
import { openEvidenceReader, openEvidenceWriter, type QueryEmbedder } from "../publication/service";
import { createChatService } from "../publication/service.createChatService";
import { KNOWLEDGE_METHODS, type KnowledgeAction, type KnowledgeBundle, type KnowledgeReaderBundle, type RequestAuthority } from "./registry";
import { KnowledgeAuthDenied, admitKnowledgeAction, type KnowledgeAuthFailure } from "./transport.admitKnowledgeAction";
import { requireBoundPeers } from "./transport.requireBoundPeers";
import { auditKnowledgeCall, type KnowledgeAuditCall, type KnowledgeAuditSink } from "./transport.auditKnowledgeCall";
import { bodyScopeRefusal } from "./transport.bodyScopeRefusal";
import { indexProfile, type IndexProfile } from "./transport.indexProfile";

/** Matches the governed kernel's own request cap exactly (publication/service.ts). */
export const MAX_KNOWLEDGE_REQUEST_BYTES = 1024 * 1024;
const READ_CEILING = MAX_KNOWLEDGE_REQUEST_BYTES + 1;
const MAX_KNOWLEDGE_REQUEST_DEPTH = 64;

export type RawBody = { readonly bytes: Uint8Array } | TransportRejection;

export const isRejection = (value: RawBody): value is TransportRejection =>
  (value as TransportRejection).status !== undefined;

/**
 * Read at most `MAX_KNOWLEDGE_REQUEST_BYTES` from the untouched stream.
 *
 * Deliberately separate from `auth/http.ts`'s `readBoundedBody`: that one is
 * pinned to the #25 memories contract's 256 KiB route cap, which is smaller
 * than the 1 MiB this kernel's own governed parser already allows. Reusing
 * it here would silently shrink the knowledge contract to a cap it never
 * declared.
 */
export async function readKnowledgeBody(request: Request): Promise<RawBody> {
  const stream = request.body;
  if (stream === null) return { bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_KNOWLEDGE_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { status: 413, error: "payload too large" };
      }
      chunks.push(value);
      if (total > READ_CEILING) break;
    }
  } catch {
    return { status: 400, error: "malformed request" };
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/** True for any of this package's three closed error envelopes. */
type EnvelopeError = { readonly code: string; readonly path: string; toJSON(): unknown };

function isEnvelopeError(error: unknown): error is EnvelopeError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { path?: unknown }).path === "string" &&
    typeof (error as { toJSON?: unknown }).toJSON === "function"
  );
}

/**
 * One fixed status per known error code, across all three envelopes
 * (`arra-error/v1`, `arra-publication-error/v1`, `arra-taxonomy-error/v1`).
 * Codes are never invented here — only mapped to a transport status.
 */
const STATUS_FOR_CODE: Readonly<Record<string, number>> = Object.freeze({
  // arra-error/v1 (contracts/errors.ts) — all are wire/contract format faults.
  invalid_json: 400,
  duplicate_key: 400,
  invalid_unicode: 400,
  invalid_type: 400,
  missing_field: 400,
  unexpected_field: 400,
  invalid_value: 400,
  out_of_range: 400,
  unsupported_version: 400,
  snapshot_position: 400,
  digest_mismatch: 400,
  target_key_mismatch: 400,
  scope_mismatch: 400,
  worker_failure: 500,
  // arra-publication-error/v1 and arra-taxonomy-error/v1 share one code set.
  // `conflict` is only ever thrown by `failTaxonomy` (TAXONOMY_ERROR_CODES) --
  // it is NOT a member of PUBLICATION_ERROR_CODES, so this entry is reachable
  // only through the taxonomy envelope today, not the publication one. It
  // sits with this shared block anyway because both envelopes read the same
  // map by code string, and a future publication code named `conflict` would
  // land on the same, already-correct status without a second entry.
  invalid_request: 400,
  not_found: 404,
  invalid_reference: 400,
  conflict: 409,
  integrity_failure: 500,
  writer_unavailable: 503,
  unsupported_dataset: 400,
  recovery_required: 503,
  limit_exceeded: 413,
  // #87 / R3: the admitted caller's own authority does not cover the request.
  forbidden: 403,
  // #32 / R9: no chat model configured, or it could not answer. Never 500.
  model_unavailable: 503,
  // #30 / R20: the dataset's pinned embedding model is not the one serving
  // now. A state conflict an operator resolves by re-indexing, not a retry.
  embedding_profile_mismatch: 409,
});

/**
 * Map a thrown error onto its transport response, preserving the envelope
 * UNCHANGED. Returns null for anything that is not one of this package's
 * three closed error types, so the caller can fall back to a fixed generic
 * 500 without ever inventing a fourth envelope.
 */
export function knowledgeErrorResponse(error: unknown): Response | null {
  if (!isEnvelopeError(error)) return null;
  const status = STATUS_FOR_CODE[error.code] ?? 500;
  return new Response(JSON.stringify(error.toJSON()), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Walk a Map-shaped parse result to the object naming `workspace_name`. */
function readWorkspaceAt(value: JcsValue, tokens: readonly string[]): string | null {
  let node: JcsValue = value;
  for (const token of tokens) {
    if (!(node instanceof Map)) return null;
    const next = node.get(token);
    if (next === undefined) return null;
    node = next;
  }
  if (!(node instanceof Map)) return null;
  const workspace = (node as JcsObject).get("workspace_name");
  return typeof workspace === "string" ? workspace : null;
}

/**
 * Parse the body ONCE with the governed strict parser, purely to read the
 * scope carrier. Throws the exact `ContractError` on a malformed document —
 * callers propagate it unchanged via `knowledgeErrorResponse`. Returns null
 * (never throws) when the document parses but simply has no valid
 * `workspace_name` at the expected path: that is a plain scope mismatch, not
 * a wire-format fault.
 */
export function peekWorkspaceName(bytes: Uint8Array, scopePath: readonly string[]): string | null {
  const parsed = parseStrictBytes(bytes, [], {
    maxBytes: MAX_KNOWLEDGE_REQUEST_BYTES,
    maxDepth: MAX_KNOWLEDGE_REQUEST_DEPTH,
  });
  return readWorkspaceAt(parsed, scopePath);
}

// ── admission ────────────────────────────────────────────────────────────

export { KnowledgeAuthDenied, admitKnowledgeAction, type KnowledgeAuthFailure } from "./transport.admitKnowledgeAction";

const AUTH_STATUS_FOR: Readonly<Record<KnowledgeAuthFailure, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  policy_unavailable: 503,
});

export { requireBoundPeers } from "./transport.requireBoundPeers";

// ── dataset access (writer-ownership decision lives here) ─────────────────

const NANOID21_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Mint a nanoid21. Modulo bias against 256 is harmless here: these are
 *  allocation identifiers, not a security boundary. */
function randomNanoid21(): string {
  const raw = randomBytes(21);
  let out = "";
  for (let i = 0; i < 21; i++) out += NANOID21_ALPHABET[raw[i]! % NANOID21_ALPHABET.length];
  return out;
}

export type KnowledgeDatasetConfig = {
  readonly datasetRoot: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * #32 / R9: the chat model and its effective settings, trusted composition
   * input (`composition.ts` builds them from env via `src/chat-model.ts`),
   * never request data. Absent means unconfigured: `answerChat` answers
   * `model_unavailable` and `getChatSettings` answers `{model: null}`.
   */
  readonly chat?: { readonly model?: ChatModelFn; readonly settings: ChatSettings | null };
  /**
   * #30: the trusted query embedder semantic search is composed with
   * (`composition.ts`: local Ollama; tests: a stub), handed to the READER only
   * (`openEvidenceReader(root, {embedder})`), like the chat model above --
   * never a writer option. Absent, or on any embedder failure, means
   * `searchKnowledgeSemantic` answers the closed `model_unavailable` code
   * (overnight R21, aligned with #32 / R9's chat code).
   */
  readonly embedder?: QueryEmbedder;
  /**
   * #30 R8's embed worker DOCUMENT embedder (`embedPendingChunks`), wired by
   * `composition.ts`'s `composeKnowledgeAccess` from `embed.ts`'s Ollama
   * `embed()`. Unlike the query `embedder` above it is a WRITER option:
   * `embedPendingChunks` is a real, durable write of `search_chunks_v1`
   * vectors, so it runs on the one cached writer. Absent (e.g. every existing
   * test's fake config) means `embedPendingChunks` still runs -- content-hash
   * reuse needs no embedder at all -- but any chunk it cannot satisfy that
   * way fails closed with `embedder_unavailable` rather than making a
   * network call this transport was never told about.
   */
  readonly documentEmbedder?: EmbedFn;
  /** #30 R20's model-digest probe, wired by `composeKnowledgeAccess`, a
   *  WRITER option beside `documentEmbedder`. Absent means every
   *  `embedPendingChunks` run is `blocked: "digest_unmeasured"` and writes
   *  nothing -- never a vector without a measured digest. */
  readonly digestProbe?: DigestProbeFn;
};

/**
 * The one process-lifetime cache. Reads are gateless and cheap to open
 * eagerly; the persisting writer is opened lazily on first use and never
 * released by a request path (see file header: writer-ownership decision).
 *
 * The reader bundle carries the `chat` facade, built over that reader's own
 * `getContext` with the configured model, so every chat call is a read; and
 * its context facade carries the #30 searches, opened with the configured
 * query embedder, so every search is a read too.
 */
export function createKnowledgeAccess(config: KnowledgeDatasetConfig) {
  let reader: Promise<KnowledgeReaderBundle> | null = null;
  let writer: Promise<Omit<import("../publication/service").EvidenceWriterBundle, "close">> | null = null;
  const chatOptions = { model: config.chat?.model, settings: config.chat?.settings ?? null };

  const requireRoot = (): string => {
    if (config.datasetRoot === undefined) {
      throw new (class extends Error {
        readonly code = "unsupported_dataset";
        readonly path = "";
        toJSON() {
          return {
            version: "arra-publication-error/v1",
            code: "unsupported_dataset",
            path: "",
            message: "unsupported target dataset",
          };
        }
      })();
    }
    return config.datasetRoot;
  };

  /** Trusted operator configuration for the one cached writer -- never
   *  request data. No model travels here any more (#32 / R9), and no query
   *  embedder either (#30): both are READER composition. What does travel
   *  here is the embed worker's document embedder and R20's digest probe:
   *  `embedPendingChunks` writes vectors, so it is writer composition. */
  const writerOptions = () => ({
    newRevisionId: randomNanoid21,
    clock: Date.now,
    env: config.env ?? process.env,
    // Trusted operator configuration, not request data: this transport
    // exposes local intake only. A namespaced source feed is a future
    // deployment decision, not something a caller's bytes can select.
    sourceNamespace: null,
    documentEmbedder: config.documentEmbedder,
    digestProbe: config.digestProbe,
  });

  return {
    /** Advertising only (#31): false hides kb_* and the v3 family from tools/list. */
    datasetConfigured: config.datasetRoot !== undefined,
    /** Server-chosen chunk-index settings for adapter writes (R18 V1). */
    indexProfile: indexProfile(),

    async getBundle(action: KnowledgeAction): Promise<KnowledgeBundle> {
      // Every action except `content:write` is a READ (#94 widened
      // `KnowledgeAction` to add `audit:read`): branching on `!== "content:write"`
      // rather than `=== "content:read"` keeps this exhaustive as read actions
      // are added, instead of silently routing a new read action into the
      // writer-gate path below, which would require a writer for a call that
      // never mutates anything and could deadlock a reader-only deployment.
      // `answerChat` (#32 / R9) and the #30 searches are among these reads.
      if (action !== "content:write") {
        reader ??= openEvidenceReader(requireRoot(), { embedder: config.embedder }).then((bundle) =>
          Object.freeze({ ...bundle, chat: createChatService(bundle.context, chatOptions) }),
        );
        return reader;
      }
      // Write path: cache only a SUCCESSFUL open. A failed attempt (writer
      // gate not yet available) must be retryable on the next request rather
      // than poisoning every future write for the rest of the process.
      if (writer === null) {
        const attempt = openEvidenceWriter(requireRoot(), writerOptions());
        attempt.catch(() => {
          if (writer === attempt) writer = null;
        });
        writer = attempt;
      }
      return writer;
    },
  };
}

/**
 * What both transports need from dataset access: one bundle per action. There
 * is deliberately no second, per-request writer here any more (#32 / R9).
 */
export type KnowledgeAccess = {
  /** False only when no dataset root is configured; see `transport.isDatasetConfigured.ts`. */
  readonly datasetConfigured?: boolean;
  /** Absent on test fakes; `mcp/legacy-v3/dispatchLegacyV3.ts` then uses the defaults. */
  readonly indexProfile?: IndexProfile;
  getBundle(action: KnowledgeAction): Promise<KnowledgeBundle>;
};

// ── HTTP handler ────────────────────────────────────────────────────────

/**
 * Handle one `POST /api/knowledge/:bank/:method` request end to end.
 *
 * Order, fixed: validate the route scope grammar and the method name (pure
 * routing, no policy I/O), check body encoding, read the bounded raw bytes,
 * peek the body's own scope claim with the governed parser, THEN admit (which
 * also yields the request's #87 `RequestAuthority`), THEN refuse a body scope
 * that differs from the route bank, THEN refuse any caller-asserted peer
 * outside the grant's binding, THEN dispatch the ORIGINAL bytes and that
 * authority to the registered method. Every outcome AFTER admission, ok or
 * error, is appended to `ctx.audit` exactly like an MCP `kb_*` call (#31 / R8;
 * see `transport.auditKnowledgeCall.ts`); a request refused before admission
 * is not audited on either transport. A body-scope mismatch is still the
 * generic 400 whatever admission decides (so no status changed), but an
 * ADMITTED caller's mismatch is audited, as MCP audits it after admission
 * (round 3, 2026-09-27). A malformed or oversized body never reaches admission
 * with a false success, but a body-format fault surfaces its own governed
 * envelope rather than a generic 400 wherever this module can tell the two
 * apart.
 */
export async function handleKnowledgeRequest(
  request: Request,
  params: { bank: string; method: string },
  ctx: { policyPath: string; access: KnowledgeAccess; audit?: KnowledgeAuditSink },
): Promise<Response> {
  if (!isValidWorkspace(params.bank)) return errorResponse(400);
  const entry = KNOWLEDGE_METHODS[params.method];
  if (entry === undefined) return errorResponse(404);

  const encoding = checkBodyEncoding(request);
  if (encoding !== null) return errorResponse(encoding.status);

  const raw = await readKnowledgeBody(request);
  if (isRejection(raw)) return errorResponse(raw.status);

  let scoped: string | null;
  try {
    scoped = peekWorkspaceName(raw.bytes, entry.scopePath);
  } catch (error) {
    const response = knowledgeErrorResponse(error);
    if (response !== null) return response;
    return errorResponse(400);
  }
  const scopeMismatch = scoped === null || scoped !== params.bank;

  let authority: RequestAuthority;
  let call: KnowledgeAuditCall | null = null;
  const startedMs = Date.now();
  try {
    authority = admitKnowledgeAction(ctx.policyPath, readAuthorization(request), params.bank, entry.action, (auth) => {
      call = { method: params.method, workspace: params.bank, bytes: raw.bytes, auth, userAgent: request.headers.get("user-agent"), startedMs };
    });
  } catch (error) {
    if (scopeMismatch) return errorResponse(400);
    if (error instanceof KnowledgeAuthDenied) return errorResponse(AUTH_STATUS_FOR[error.code]);
    return errorResponse(503);
  }
  const audited = call as KnowledgeAuditCall | null;
  const audit = (outcome: Parameters<typeof auditKnowledgeCall>[2]) =>
    audited === null ? Promise.resolve() : auditKnowledgeCall(ctx.audit, audited, outcome);
  if (scopeMismatch) {
    await audit({ status: "error", error: bodyScopeRefusal() });
    return errorResponse(400);
  }
  try {
    requireBoundPeers(params.method, raw.bytes, authority);
  } catch (error) {
    await audit({ status: "error", error });
    return knowledgeErrorResponse(error) ?? errorResponse(400);
  }

  try {
    // Operations-root methods (R5) never touch the knowledge bundle at all --
    // checked BEFORE `getBundle`, which would otherwise throw
    // `unsupported_dataset` whenever `ARRA_KNOWLEDGE_DATASET_ROOT` is unset,
    // even though `entry.call` would never have used the bundle it opened.
    if (entry.operations !== undefined) {
      const result = await entry.operations(raw.bytes);
      await audit({ status: "ok", value: result });
      return new Response(JSON.stringify(result ?? null), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    const bundle = await ctx.access.getBundle(entry.action);
    const result = await entry.call(bundle, raw.bytes, authority);
    await audit({ status: "ok", value: result });
    return new Response(JSON.stringify(result ?? null), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    await audit({ status: "error", error });
    const response = knowledgeErrorResponse(error);
    if (response !== null) return response;
    return new Response(JSON.stringify({ error: "internal" }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
