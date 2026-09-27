/**
 * Trusted startup composition (`authorization-integration-v1.md` §3).
 *
 * This is the ONLY module that wires raw data, model and audit dependencies
 * into the facade. It is not an HTTP or MCP adapter and exposes no anonymous
 * operation API.
 *
 * Importing this module performs no configuration reading, no file or store
 * access and no listening. The raw modules are imported lazily inside the
 * builder so that merely importing the composition graph cannot trigger their
 * import-time environment reads.
 */

import { createRequire } from "node:module";
import { createOperationService, type OperationService, type StoreDependencies } from "./auth/service.createOperationService";
import { createKnowledgeAccess, type KnowledgeAccess } from "./knowledge/transport";

export type RuntimeConfig = {
  readonly policyPath: string;
  readonly origin: string;
  readonly port: number;
  /** R18 D10: the v3-compatible MCP family. Absent = off. */
  readonly v3Compat?: boolean;
};

/**
 * The transports this build has raw-wire evidence for.
 *
 * The header-flattening and body-bound behaviour was measured on exactly these
 * versions. An unsupported runtime must REFUSE to start rather than warn and
 * continue, because the grammar gate silently depends on that behaviour.
 */
export const SUPPORTED_BUN = "1.3.14";
export const SUPPORTED_ELYSIA = "1.4.30";

/** The explicit global body backstop, deliberately ABOVE the 256 KiB route cap. */
export const GLOBAL_BODY_BACKSTOP = 1024 * 1024;

export type VersionCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Read the INSTALLED Elysia version from its package metadata.
 *
 * Reads only; it edits no manifest and no lockfile, both of which are frozen.
 * Returns undefined when the metadata cannot be read, which the caller treats
 * as unsupported rather than as "skip the check".
 */
export function readInstalledElysiaVersion(): string | undefined {
  try {
    const require_ = createRequire(import.meta.url);
    const metadata = require_("elysia/package.json") as { version?: unknown };
    return typeof metadata.version === "string" ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate the installed runtime versions, reading both by DEFAULT.
 *
 * The earlier version only checked Elysia when a version was passed in, so the
 * real startup path never checked it at all while the tests — which did pass
 * one — made it look covered. Both are now read from the installed runtime by
 * default and both fail closed when absent.
 */
export function checkSupportedRuntime(
  bunVersion: string | undefined = typeof Bun === "undefined" ? undefined : Bun.version,
  elysiaVersion: string | undefined = readInstalledElysiaVersion(),
): VersionCheck {
  if (bunVersion !== SUPPORTED_BUN) {
    return { ok: false, reason: `unsupported Bun runtime: expected ${SUPPORTED_BUN}` };
  }
  if (elysiaVersion === undefined) {
    return { ok: false, reason: "could not determine the installed Elysia version" };
  }
  if (elysiaVersion !== SUPPORTED_ELYSIA) {
    return { ok: false, reason: `unsupported Elysia version: expected ${SUPPORTED_ELYSIA}` };
  }
  return { ok: true };
}

/** Read and validate configuration. Called at startup, never at import. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const policyPath = env.ARRA_AUTH_POLICY;
  if (typeof policyPath !== "string" || !policyPath.startsWith("/")) {
    throw new Error("ARRA_AUTH_POLICY must be an absolute path to the policy file");
  }
  const port = Number(env.PORT ?? 3939);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }
  const origin = env.ARRA_ORIGIN ?? `http://127.0.0.1:${port}`;
  // Fail fast on an unusable origin rather than at the first request.
  const parsed = new URL(origin);
  if (parsed.origin !== origin.replace(/\/$/, "")) {
    throw new Error("ARRA_ORIGIN must be an exact scheme://authority with no path");
  }
  return Object.freeze({ policyPath, origin: parsed.origin, port });
}

/**
 * The ONE audit sink (§4, DECISIONS.md R5): an `mcp_calls` row plus the
 * `connections` fold, both in the operations root. MCP reaches it through
 * `composeService` (`appendAudit`); `POST /api/knowledge/:bank/:method` (#31,
 * R8) through `buildApp`. One sink, so HTTP, MCP and the CLI land in the same
 * tables with the same redaction and attribution.
 */
export async function composeAuditSink(): Promise<StoreDependencies["logCall"]> {
  const calls = await import("./mcp/calls");
  const connections = await import("./mcp/connections");
  return (record) => {
    const entry = record as {
      tool: string;
      input: unknown;
      status: "ok" | "error";
      result: unknown;
      duration_ms: number;
      workspace_name: string;
      session_name?: string | null;
      client_label?: string | null;
      peer_name?: string | null;
      requested_as?: string | null;
      transport?: string | null;
      remote_ip?: string | null;
      auth: { principal_id: string; credential_id: string; policy_version: string };
    };
    // #102: the same admitted request feeds BOTH operations tables. The log
    // is per-call and append-only; the fold is per-caller and bounded by the
    // caller population. Fired without await and with its own catch so a
    // dashboard-only table can never delay or fail the request it describes
    // -- `foldConnection` is already best-effort internally, this is the
    // second belt.
    void connections
      .foldConnection({
        workspace_name: entry.workspace_name,
        // DECISIONS.md R19: SPEC §7.2 defines `method` as the AUTH method
        // (bearer | oauth | owner-session), not the transport. Every request
        // that reaches this fold was admitted by an arra-auth/v1 bearer
        // credential (auth/http.ts); oauth and owner sessions do not exist yet.
        method: "bearer",
        // DECISIONS.md R5: `principal` is the CREDENTIAL id, matching
        // SPEC §7.2 ("token id or oauth client_id") -- never `principal_id`,
        // which names the PERSON/service the credential belongs to, not the
        // credential itself. One principal can hold several credentials,
        // each a distinct caller from this table's point of view.
        principal: entry.auth.credential_id,
        label: entry.client_label?.trim() ? entry.client_label : "unlabelled",
        user_agent: entry.client_label ?? null,
        // DECISIONS.md R5: stays null. No caller of `logCall` ever sets
        // `entry.remote_ip` today (`appendAudit` in `auth/service.ts` does
        // not collect it) -- capturing it is a privacy decision left for a
        // later slice, not silently done here.
        remote_ip: entry.remote_ip ?? null,
        tool: entry.tool,
      })
      .catch(() => {});
    return calls.logCall({
      tool: entry.tool,
      input: entry.input,
      status: entry.status,
      result: entry.result,
      duration_ms: entry.duration_ms,
      workspace_name: entry.workspace_name,
      // peer_name stays a DOMAIN field: the principal never populates it.
      // It carries only the speaker the connection ASSERTED (X-Arra-Peer,
      // R18 A7), which the service already checked against the grant.
      peer_name: entry.peer_name ?? null,
      requested_as: entry.requested_as ?? null,
      session_name: entry.session_name ?? null,
      client_label: entry.client_label ?? null,
      auth: entry.auth,
    });
  };
}

/**
 * Build the operation service over the real store/embedder/audit modules.
 *
 * These are imported lazily and deliberately: adapters never see these handles,
 * only the credential-taking service returned here.
 */
export async function composeService(config: RuntimeConfig): Promise<OperationService> {
  const store = await import("./db");
  const embed = await import("./embed");
  const calls = await import("./mcp/calls");

  const deps: StoreDependencies = {
    insert: (row) => store.insert(row),
    list: (bank, limit, filters) => store.list(bank, limit, filters as never),
    searchText: (q, bank, limit) => store.searchText(q, bank, limit),
    searchVector: (q, bank, limit) => store.searchVector(q, bank, limit),
    getById: (bank, id) => store.getById(bank, id),
    stats: (bank) => store.stats(bank) as Promise<Record<string, unknown>>,
    backfill: (batch) => store.backfill(batch),
    ensureFtsIndex: (replace) => store.ensureFtsIndex(replace),
    embedHealth: () => embed.health(),
    recentCalls: (bank, limit, status) => calls.recent(bank, limit, status),
    aggregateCalls: (bank) => calls.aggregate(bank),
    logCall: await composeAuditSink(),
  };

  return createOperationService({ policyPath: config.policyPath, v3Compat: config.v3Compat === true }, deps);
}

/**
 * R18 D10: `ARRA_MCP_V3_COMPAT` turns on the v3-compatible MCP family
 * (`mcp/legacy-v3/`). Trusted operator configuration, read here and nowhere
 * else, never from a request. Only the exact value "1" enables it, so a typo
 * or "true" leaves the default (off) in place rather than guessing.
 */
export function composeV3Compat(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARRA_MCP_V3_COMPAT === "1";
}

/**
 * #31 knowledge dataset access, built from environment configuration.
 *
 * `ARRA_KNOWLEDGE_DATASET_ROOT` is optional: an existing deployment that has
 * not adopted the publication/taxonomy/context/evidence dataset yet keeps
 * starting up exactly as before, and every `/api/knowledge/*` route (and
 * every `kb_*` MCP tool) answers a fixed `unsupported_dataset` envelope
 * instead of trying to open a dataset that was never configured. Reads and
 * the writer are still opened lazily inside `createKnowledgeAccess` — this
 * function only decides WHERE, never whether a connection is attempted yet.
 *
 * #32 / R9: the chat model is composed HERE, from env, and handed to the
 * access as trusted configuration -- the only place a model is wired. The
 * model module is imported lazily, like `embed.ts` in `composeService`.
 * `ARRA_CHAT_PROVIDER` unset leaves chat unconfigured (`model_unavailable`);
 * a malformed `ARRA_CHAT_*` throws, and `startup` checks that first. The #30
 * query embedder is composed here the same way, for the same reader.
 *
 * #30 R8 / R20: the embed worker's DOCUMENT embedder and the model-digest
 * probe are composed here too, but for the WRITER: `embedPendingChunks`
 * writes vectors, so it runs on the one cached writer, never the reader.
 * Query and document embedder share one model, the #30 registry's active
 * profile (`search-chunk.profiles.ts`), so a query vector and the chunk
 * vectors it is compared with always come from the same model, stored under
 * the same profile id. Neither embedder nor the probe is called here: boot
 * never probes the model and never pins a digest (R20).
 */
export async function composeKnowledgeAccess(env: NodeJS.ProcessEnv = process.env): Promise<KnowledgeAccess> {
  const datasetRoot = env.ARRA_KNOWLEDGE_DATASET_ROOT;
  const { createChatModel } = await import("./chat-model");
  const chat = createChatModel(env);
  // The registry reads EMBEDDING_MODEL from `process.env` once, at import
  // (like `embed.ts`), so the profile every chunk row is indexed under is
  // fixed for the process; imported lazily here, per this module's header.
  const { ACTIVE_EMBEDDING_PROFILE } = await import("./publication/search-chunk.profiles");
  const embeddingModel = ACTIVE_EMBEDDING_PROFILE.model;
  return createKnowledgeAccess({
    datasetRoot: typeof datasetRoot === "string" && datasetRoot.trim() ? datasetRoot : undefined,
    env,
    chat: { model: chat.model, settings: chat.settings },
    // #30 semantic search: the query embedder is `embed.ts`'s local Ollama
    // client, imported lazily on first use like `composeService`'s raw
    // modules, and handed to the READER only (like the chat model above,
    // never a writer option). Its profile is the #30 registry's active
    // profile id -- the one name `indexRevisionChunks` accepts and stores --
    // and it calls that profile's own model, so the profile a search reports
    // can never differ from the model that embedded its query. (Integration
    // merge: this replaces the retrieval slice's model-name-as-profile seam.)
    embedder: {
      profile: ACTIVE_EMBEDDING_PROFILE.profile_id,
      embed: async (text: string) => (await import("./embed")).embedOne(text, embeddingModel),
    },
    // #30 R8: the embed worker's DOCUMENT embedder, a WRITER option (see
    // above) and named apart from the reader's query `embedder`. The same
    // Ollama call and the same model, lazily imported so merely composing
    // knowledge access cannot trigger `embed.ts`'s own import-time
    // environment reads (this module's own header rule).
    documentEmbedder: (texts, signal) => import("./embed").then((mod) => mod.embed(texts, embeddingModel, signal)),
    // #30 R20: the model-digest probe every `embedPendingChunks` run makes
    // before embedding anything -- `GET /api/tags` on the same OLLAMA_URL and
    // EMBEDDING_MODEL `embed.ts` uses. Called per run, never at boot.
    digestProbe: (signal) =>
      import("./publication/search-chunk.fetchOllamaModelDigest").then((mod) =>
        mod.fetchOllamaModelDigest({ signal }),
      ),
  });
}

/**
 * Validate the chat model configuration (#32 / R9) the way `readConfig`
 * validates the rest: at startup, before listen, failing closed. Contacts no
 * model -- reachability is a per-answer outcome (`model_unavailable`), not a
 * startup precondition, so a stopped Ollama never stops the server.
 */
export async function checkChatConfig(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { readChatConfig } = await import("./chat-model");
  readChatConfig(env);
}

/**
 * Trusted startup index work.
 *
 * Lives here, not in the HTTP entrypoint: §3 keeps index/app free of raw store
 * imports, and startup maintenance is an operator path, not a request path.
 *
 * #30 R20: boot never probes the embedding model, never pins its digest and
 * never changes an embedding profile id. The digest is measured by every
 * `embedPendingChunks` run instead (`search-chunk-digest-boot.test.ts` runs
 * this function against a live stub Ollama and asserts zero requests).
 */
export async function runStartupIndexWork(): Promise<void> {
  const store = await import("./db");
  // Do not rebuild a matching index on every restart, and never mutate on read.
  // An index whose live details differ from the shared trigram config (an older
  // deployment's icu) is rebuilt here once, before listen (R14, #10).
  await store.ensureFtsIndex(false);
}
