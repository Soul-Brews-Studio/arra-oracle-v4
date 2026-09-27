/**
 * The HTTP surface, built from an admitted operation facade
 * (`authorization-integration-v1.md` §1, §2).
 *
 * This module imports no store, no embedder, no storage config and no audit
 * table. It receives the operation service only -- never a raw handle, a gate
 * or a request context -- so no route here can reach data without admission.
 *
 * Fixed order on every request: classify public/protected, enforce Host then
 * Origin, resolve the minimum scope carrier, load policy, sample the clock,
 * admit, and only then touch a payload or dispatch. Policy failure deliberately
 * takes precedence over credential failure once scope and transport are valid.
 */

import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import {
  checkBodyEncoding,
  checkHostAndOrigin,
  errorResponse,
  isRejection,
  isValidWorkspace,
  readAuthorization,
  readBoundedBody,
} from "./auth/http";
import { AuthDenied, type McpEnvelope, type OperationService } from "./auth/service.createOperationService";
import { searchAnswer } from "./auth/service.searchAnswer";
import { decodeUtf8Strict, LIMITS, parseStrict } from "./contracts/jcs";
import { SERVER_NAME, SERVER_VERSION } from "./mcp/protocol";
import { handshakeResponse, type createMcpAdapter } from "./mcp";
import { handleKnowledgeRequest, type KnowledgeAccess } from "./knowledge/transport";
import { memoryInsertErrorResponse } from "./app.memoryInsertErrorResponse";
import type { KnowledgeAuditSink } from "./knowledge/transport.auditKnowledgeCall";

export type AppConfig = {
  /** Exact scheme/authority this process answers for, e.g. http://127.0.0.1:3939 */
  readonly origin: string;
  /** R18 D10: the v3-compatible MCP family flag. Only with it on is
   *  X-Arra-Peer read; absent = off, so the header is ignored as before. */
  readonly v3Compat?: boolean;
};

/** A bounded-body rejection raised from inside a post-admission hook. Its
 *  message is what the audit row records (#31 legacy-audit): the text the MCP
 *  twin's validation raises for the same argument, so the two rows agree. */
class BodyRejected extends Error {
  constructor(readonly status: number, message = "body rejected") {
    super(message);
  }
}

/** A query parameter in its MCP argument shape: digits as the number they
 *  spell, even past 2^53 (a JSON number MCP would refuse with the same text);
 *  anything else, and digits too long for a finite number, as the string. */
const argValue = (raw: string): string | number => (/^\d+$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : raw);

/** The MCP `bounded()` text for a `limit` that `positiveInt` refused, keyed on
 *  the type `argValue` records, so the row's input and text agree. */
const limitRejected = (raw: string | null) =>
  new BodyRejected(400, raw !== null && typeof argValue(raw) === "number" ? "limit must be a safe integer between 1 and 1000" : "limit must be a number");

const STATUS_FOR: Readonly<Record<string, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  policy_unavailable: 503,
  invalid_request: 503,
  invalid_scope: 400,
});

const denialResponse = (error: unknown): Response => {
  const code = error instanceof AuthDenied ? error.code : "policy_unavailable";
  return errorResponse(STATUS_FOR[code] ?? 503);
};

const noStore = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const positiveInt = (value: unknown, fallback: number): number | null => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : null;
};

/**
 * Exactly one bank query parameter that satisfies the workspace grammar.
 *
 * "ambiguous" covers missing-but-required, repeated, and malformed alike: all
 * are 400 before any policy work, never a policy-unavailable 503.
 */
const bankParam = (url: URL): string | null | "ambiguous" => {
  const all = url.searchParams.getAll("bank");
  if (all.length === 0) return null;
  if (all.length > 1) return "ambiguous";
  const value = all[0]!;
  return isValidWorkspace(value) ? value : "ambiguous";
};

export function createApp(
  config: AppConfig,
  service: OperationService,
  mcpHandle: ReturnType<typeof createMcpAdapter>,
  options: {
    readonly assets?: string;
    /** #31: publication/taxonomy/context/evidence transport. Optional so every
     *  existing test that constructs `createApp` with 3 args keeps working;
     *  omitting it means `/api/knowledge/*` answers a fixed 404. `audit` is
     *  the composed §4 sink (#31 / R8); absent, an admitted call is not audited. */
    readonly knowledge?: { policyPath: string; access: KnowledgeAccess; audit?: KnowledgeAuditSink };
  } = {},
) {
  const origin = new URL(config.origin);

  /** Host/Origin gate for EVERY route, public ones included. */
  const transportGuard = (request: Request): Response | null => {
    const rejection = checkHostAndOrigin(request, origin);
    return rejection === null ? null : errorResponse(rejection.status);
  };

  /** Run one service call, mapping any denial onto its fixed response. */
  const guarded = async (run: () => Promise<unknown>, status = 200): Promise<Response> => {
    try {
      return noStore(await run(), status);
    } catch (error) {
      if (error instanceof BodyRejected) return errorResponse(error.status);
      return denialResponse(error);
    }
  };

  /**
   * The bounded body rules for a protected POST that carries no JSON scope.
   *
   * Passed to the service as a post-admission hook, so it runs only after the
   * global grant is admitted and always before the mutation.
   */
  const bodyGate = (request: Request) => async (): Promise<void> => {
    const hasBody = request.body !== null || request.headers.get("content-length") !== null;
    if (!hasBody) return;
    const encoding = checkBodyEncoding(request);
    if (encoding !== null) throw new BodyRejected(encoding.status);
    const raw = await readBoundedBody(request);
    if (isRejection(raw)) throw new BodyRejected(raw.status);
  };

  const app = new Elysia()

    // EVERY route and asset passes the transport guard. Per-route checks alone
    // left the static plugin answering 200 to a mismatched Host or Origin,
    // because it never reached a handler of mine.
    .onRequest(({ request }) => {
      const rejection = checkHostAndOrigin(request, origin);
      if (rejection !== null) return errorResponse(rejection.status);
    })

    // ── MCP ────────────────────────────────────────────────────────────────
    // parse:"none" so the framework performs no decoding before admission.
    .post(
      "/mcp/:bank",
      async ({ params, request }) => {
        const blocked = transportGuard(request);
        if (blocked) return blocked;
        // The route bank is a scope carrier: same grammar, checked before any
        // policy I/O, so an over-long bank is 400 rather than a 503 from the
        // loader doing work for a request that was never valid.
        if (!isValidWorkspace(params.bank)) return errorResponse(400);
        // A7/D8 (R18): X-Arra-Peer is the connection-level speaker ASSERTION,
        // part of the v3 family: with the flag off it is not read at all.
        // Same bounded name grammar as the bank, checked before any policy
        // I/O; whether this credential may assert it is the service's call.
        const peerHeader = config.v3Compat === true ? request.headers.get("x-arra-peer") : null;
        if (peerHeader !== null && !isValidWorkspace(peerHeader)) return errorResponse(400);
        const encoding = checkBodyEncoding(request);
        if (encoding) return errorResponse(encoding.status);

        // A mutable box: these are written inside the lazy reader closure, and
        // a plain `let` would be narrowed to `null` at the read site below.
        const pending: { rejection: number | null; handshake: Response | null } = {
          rejection: null,
          handshake: null,
        };
        // LAZY: the service invokes this only after the four-action projection
        // succeeds, so an unadmitted caller's body is never read or parsed.
        const readEnvelope = async (): Promise<McpEnvelope | null> => {
          const raw = await readBoundedBody(request);
          if (isRejection(raw)) {
            pending.rejection = raw.status;
            return null;
          }
          try {
            const textBody = decodeUtf8Strict(raw.bytes, LIMITS.maxDocumentBytes, []);
            const parsed = parseStrict(textBody, [], { maxDepth: 64 });
            if (!(parsed instanceof Map)) {
              pending.rejection = 400;
              return null;
            }
            const plain = JSON.parse(
              JSON.stringify(parsed, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v)),
            ) as Record<string, unknown>;
            const method = plain.method;
            if (typeof method !== "string") {
              pending.rejection = 400;
              return null;
            }
            const rawParams = plain.params ?? {};
            if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
              pending.rejection = 400;
              return null;
            }
            const handshake = handshakeResponse(method, (plain.id ?? null) as never, rawParams as Record<string, unknown>);
            if (handshake !== null) {
              pending.handshake = handshake;
              return null;
            }
            return {
              method,
              id: (plain.id ?? null) as string | number | null,
              params: rawParams as Record<string, unknown>,
            };
          } catch {
            pending.rejection = 400;
            return null;
          }
        };

        const result = await mcpHandle(
          params.bank,
          readAuthorization(request),
          readEnvelope,
          request.headers.get("user-agent") ?? "",
          peerHeader,
        );
        if (pending.handshake !== null) {
          pending.handshake.headers.set("cache-control", "no-store");
          return pending.handshake;
        }
        if (pending.rejection !== null) return errorResponse(pending.rejection);
        if (result.kind === "denied") return errorResponse(STATUS_FOR[result.code] ?? 503);
        const response = result.response;
        response.headers.set("cache-control", "no-store");
        return response;
      },
      { parse: "none" },
    )
    // The retired workspace segment never had room semantics, so it is refused
    // explicitly rather than silently ignored -- and it never runs a tool.
    .post("/mcp/:bank/:workspace", ({ request }) => {
      const blocked = transportGuard(request);
      if (blocked) return blocked;
      return new Response(
        JSON.stringify({ error: "workspace path segment is not supported; use /mcp/:bank" }),
        { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    })

    // ── public liveness: constant, zero storage/model/policy I/O ───────────
    .get("/health", ({ request }) => {
      const blocked = transportGuard(request);
      if (blocked) return blocked;
      return new Response(
        JSON.stringify({ version: `${SERVER_NAME} ${SERVER_VERSION}`, auth: "bearer" }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    })

    // ── protected HTTP API ────────────────────────────────────────────────
    .get("/api/health", async ({ request }) => {
      const blocked = transportGuard(request);
      if (blocked) return blocked;
      const url = new URL(request.url);
      const bank = bankParam(url);
      if (bank === null || bank === "ambiguous") return errorResponse(400);
      // Audited as MCP `bank_info`, its diagnostics:read twin (#31 legacy-audit).
      const http = { userAgent: request.headers.get("user-agent") ?? "", input: {} };
      return guarded(() => service.diagnostics(readAuthorization(request), bank, http));
    })

    .get("/api/memories", async ({ request }) => {
      const blocked = transportGuard(request);
      if (blocked) return blocked;
      const url = new URL(request.url);
      const bank = bankParam(url);
      if (bank === null || bank === "ambiguous") return errorResponse(400);
      // Non-scope parameters are checked INSIDE the guarded call, after the
      // same admission: an unauthenticated caller must not learn that its
      // limit was malformed.
      // Audited as MCP `list_memories` (#31 legacy-audit), with its arguments.
      const rawLimit = url.searchParams.get("limit");
      const http = { userAgent: request.headers.get("user-agent") ?? "", input: rawLimit === null ? {} : { limit: argValue(rawLimit) } };
      return guarded(async () => {
        const limit = positiveInt(rawLimit ?? undefined, 50);
        return service.listMemories(readAuthorization(request), bank, limit ?? 50, () =>
          limit === null ? limitRejected(rawLimit) : null,
        http);
      });
    })

    .get("/api/search", async ({ request }) => {
      const blocked = transportGuard(request);
      if (blocked) return blocked;
      const url = new URL(request.url);
      const bank = bankParam(url);
      if (bank === null || bank === "ambiguous") return errorResponse(400);
      const q = url.searchParams.get("q");
      const mode = url.searchParams.get("mode") ?? "text";
      const rawLimit = url.searchParams.get("limit");
      const limit = positiveInt(rawLimit ?? undefined, 10);
      // Audited as MCP `recall` (#31 legacy-audit): only the arguments sent,
      // in the order the URL sent them (MCP records its caller's key order),
      // each at its first occurrence, the one `get` reads.
      const input: Record<string, string | number> = {};
      for (const [key, raw] of url.searchParams) {
        const arg = key === "q" ? "query" : key === "mode" || key === "limit" ? key : null;
        if (arg !== null && !(arg in input)) input[arg] = arg === "limit" ? argValue(raw) : raw;
      }
      const searchMode = mode === "vector" ? "vector" : "text";
      return guarded(async () => {
        const result = await service.searchMemories(
          readAuthorization(request),
          bank,
          typeof q === "string" ? q : "",
          searchMode,
          limit ?? 10,
          // The order and text of MCP `recall`'s own checks: query, limit, mode.
          () => {
            if (typeof q !== "string") return new BodyRejected(400, "query is required");
            if (!q.trim()) return new BodyRejected(400, "query must be a non-blank string");
            if (limit === null) return limitRejected(rawLimit);
            if (mode !== "text" && mode !== "vector") return new BodyRejected(400, "mode must be 'text' or 'vector'");
            return null;
          },
          { userAgent: request.headers.get("user-agent") ?? "", input },
        );
        // Text mode says how it matched (R14); the one shape the audit row records too.
        return searchAnswer(searchMode, result);
      });
    })

    // The only protected route whose scope lives in the JSON body.
    .post(
      "/api/memories",
      async ({ request }) => {
        const blocked = transportGuard(request);
        if (blocked) return blocked;
        const encoding = checkBodyEncoding(request);
        if (encoding) return errorResponse(encoding.status);

        const raw = await readBoundedBody(request);
        if (isRejection(raw)) return errorResponse(raw.status);

        // Bounded strict parse purely to extract the scope carrier. No store,
        // model or audit work happens here.
        let document: Map<string, unknown>;
        try {
          const textBody = decodeUtf8Strict(raw.bytes, LIMITS.maxDocumentBytes, []);
          const parsed = parseStrict(textBody, [], { maxDepth: 64 });
          if (!(parsed instanceof Map)) return errorResponse(400);
          document = parsed as Map<string, unknown>;
        } catch {
          return errorResponse(400);
        }

        const workspace = document.get("workspace_name");
        if (!isValidWorkspace(workspace)) return errorResponse(400);

        // A query bank is tolerated only when identical; never authoritative.
        const url = new URL(request.url);
        const bank = bankParam(url);
        if (bank === "ambiguous") return errorResponse(400);
        if (bank !== null && bank !== workspace) return errorResponse(400);

        // Non-scope fields are validated by this builder, which the service
        // invokes ONLY after admitting content:write. A denied caller therefore
        // triggers no storage access and sees no field-level error. It checks
        // in MCP `remember`'s order with its texts, which the audit records;
        // unlike MCP, `name` is required here.
        const buildRow = () => {
          const optional = (key: string) => {
            const value = document.get(key);
            if (value === undefined) return undefined;
            if (typeof value === "string" && value.trim()) return value;
            throw new BodyRejected(400, `${key} must be a non-blank string`);
          };
          const content = optional("content");
          if (content === undefined) throw new BodyRejected(400, "content is required");
          const name = optional("name");
          if (name === undefined) throw new BodyRejected(400, "name is required");
          return {
            name,
            content,
            type: optional("type"),
            session_name: optional("session_name"),
            peer_name: optional("peer_name"),
            subject_peer_name: optional("subject_peer_name"),
          };
        };
        // Audited as MCP `remember` (#31 legacy-audit): the body is its
        // arguments minus the scope carrier, which MCP refuses in arguments.
        let input: Record<string, unknown> | undefined;
        try {
          input = JSON.parse(JSON.stringify(document, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v)));
          delete input!.workspace_name;
        } catch {}
        const http = { userAgent: request.headers.get("user-agent") ?? "", input };
        try {
          return noStore(await service.insertMemory(readAuthorization(request), workspace, buildRow, http), 201);
        } catch (error) {
          // A malformed body only becomes visible to an ADMITTED caller.
          if (error instanceof BodyRejected) return errorResponse(error.status);
          // D5a HTTP parity: see `app.memoryInsertErrorResponse.ts`.
          return memoryInsertErrorResponse(error, denialResponse);
        }
      },
      { parse: "none" },
    )

    .post(
      "/api/backfill",
      async ({ request }) => {
        const blocked = transportGuard(request);
        if (blocked) return blocked;
        const url = new URL(request.url);
        // A bank never scopes a global action; supplying one is a 400.
        if (bankParam(url) !== null) return errorResponse(400);
        const batch = positiveInt(url.searchParams.get("batch") ?? undefined, 32);
        // Not audited (#31 legacy-audit): a global action has no MCP twin and
        // no workspace for an `mcp_calls` row (`workspace_name` is non-null).
        return guarded(() =>
          service.backfill(readAuthorization(request), batch ?? 32, async () => {
            // Non-scope parameter, checked only after the global admission.
            if (batch === null) throw new BodyRejected(400);
            await bodyGate(request)();
          }),
        );
      },
      { parse: "none" },
    )

    .post(
      "/api/reindex",
      async ({ request }) => {
        const blocked = transportGuard(request);
        if (blocked) return blocked;
        if (bankParam(new URL(request.url)) !== null) return errorResponse(400);
        return guarded(async () => ({
          indices: await service.reindex(readAuthorization(request), bodyGate(request)),
        }));
      },
      { parse: "none" },
    )

    // ── knowledge transport (#31): publication/taxonomy/context/evidence ───
    // `parse: "none"` for the same reason as every other protected POST: the
    // raw bytes must reach the governed parser untouched. `:bank` is the
    // ADMITTED scope; the body's own `workspace_name` is checked against it
    // before dispatch, never trusted on its own (see knowledge/transport.ts).
    .post(
      "/api/knowledge/:bank/:method",
      async ({ params, request }) => {
        const blocked = transportGuard(request);
        if (blocked) return blocked;
        if (options.knowledge === undefined) return errorResponse(404);
        return handleKnowledgeRequest(request, params, options.knowledge);
      },
      { parse: "none" },
    );

  return options.assets === undefined
    ? app
    : app.use(
        staticPlugin({
          assets: options.assets,
          prefix: "/",
          // `maxAge: 0` because the default is 86400 -- one day -- and it was
          // applied to index.html as well as to content-hashed assets.
          // Measured: `Cache-Control: public, max-age=86400` on
          // /v2/index.html. A built SPA writes a NEW hashed asset every
          // build but the same index.html, so a cached entry point loads
          // yesterday's JavaScript against today's HTML for up to 24 hours.
          // It presents as "my change did nothing", and it cost three
          // debugging detours here before it was recognised.
          //
          // Zero does not mean "re-download everything": ETag is still sent,
          // so a revalidation answers 304 with no body when nothing changed.
          // The cost is one conditional request per asset; the alternative is
          // a UI that silently serves stale code after every deploy.
          maxAge: 0,
          // Keep the ETag. `maxAge: 0` omits Cache-Control entirely, and an
          // absent header lets a browser cache heuristically off
          // Last-Modified -- the same staleness by a quieter route. An ETag
          // gives the browser something to revalidate against, so an
          // unchanged file costs a 304 with no body while a changed one can
          // never be served from cache.
          etag: true,
        }),
      );
}
