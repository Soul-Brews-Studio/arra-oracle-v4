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
import { createOperationService, type OperationService, type StoreDependencies } from "./auth/service";
import { createKnowledgeAccess, type KnowledgeAccess } from "./knowledge/transport";
import { DEFAULT_EMBEDDING_PROFILE } from "./publication/search-chunk.defaultEmbeddingProfile";

export type RuntimeConfig = {
  readonly policyPath: string;
  readonly origin: string;
  readonly port: number;
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
 * Build the operation service over the real store/embedder/audit modules.
 *
 * These are imported lazily and deliberately: adapters never see these handles,
 * only the credential-taking service returned here.
 */
export async function composeService(config: RuntimeConfig): Promise<OperationService> {
  const store = await import("./db");
  const embed = await import("./embed");
  const calls = await import("./mcp/calls");
  const connections = await import("./mcp/connections");

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
    logCall: (record) => {
      const entry = record as {
        tool: string;
        input: unknown;
        status: "ok" | "error";
        result: unknown;
        duration_ms: number;
        workspace_name: string;
        session_name?: string | null;
        client_label?: string | null;
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
          // "unknown" rather than a guess: `method` is NOT NULL and the read
          // validates it as nonempty text, so a transport that did not say
          // must still round-trip as something a human can read as "we were
          // not told" -- never silently attributed to http or mcp.
          method: entry.transport?.trim() ? entry.transport : "unknown",
          principal: entry.auth.principal_id,
          label: entry.client_label?.trim() ? entry.client_label : "unlabelled",
          user_agent: entry.client_label ?? null,
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
        peer_name: null,
        session_name: entry.session_name ?? null,
        client_label: entry.client_label ?? null,
        auth: entry.auth,
      });
    },
  };

  return createOperationService({ policyPath: config.policyPath }, deps);
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
 */
export function composeKnowledgeAccess(env: NodeJS.ProcessEnv = process.env): KnowledgeAccess {
  const datasetRoot = env.ARRA_KNOWLEDGE_DATASET_ROOT;
  return createKnowledgeAccess({
    datasetRoot: typeof datasetRoot === "string" && datasetRoot.trim() ? datasetRoot : undefined,
    env,
    // #30 semantic search: the query embedder is the same local Ollama model
    // `embed.ts` serves, imported lazily on first use like `composeService`'s
    // raw modules. Its profile is that model's name -- the name an embed
    // worker stores via `indexRevisionChunks` -- with `embed.ts`'s own default
    // (`all-minilm`, `DEFAULT_EMBEDDING_PROFILE`). SEAM: the concurrent
    // profile registry replaces this pairing with a registry entry.
    embedder: {
      profile: env.EMBEDDING_MODEL?.trim() ? env.EMBEDDING_MODEL : DEFAULT_EMBEDDING_PROFILE,
      embed: async (text: string) => (await import("./embed")).embedOne(text),
    },
  });
}

/**
 * Trusted startup index work.
 *
 * Lives here, not in the HTTP entrypoint: §3 keeps index/app free of raw store
 * imports, and startup maintenance is an operator path, not a request path.
 */
export async function runStartupIndexWork(): Promise<void> {
  const store = await import("./db");
  // Do not rebuild a matching index on every restart, and never mutate on read.
  // An index whose live details differ from the shared trigram config (an older
  // deployment's icu) is rebuilt here once, before listen (R14, #10).
  await store.ensureFtsIndex(false);
}
