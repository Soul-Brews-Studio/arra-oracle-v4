import {
  ACTIVE_EMBEDDING_MODEL_NAME,
  configureActiveEmbeddingModelDigest,
  fetchOllamaModelDigest,
} from "./search-chunk.profiles";
import { readPinnedModelDigest } from "./search-chunk.readPinnedModelDigest";
import { writePinnedModelDigest } from "./search-chunk.writePinnedModelDigest";

/** Used only when `ARRA_STARTUP_DIGEST_TIMEOUT_MS` is unset, empty, or not a
 *  positive number -- the same guard `service.embedPendingChunks.ts`'s
 *  `EMBED_CALL_TIMEOUT_MS` was missing (fix-round nonblocking finding): an
 *  empty-string env var reads as `Number("") === 0`, which would time out
 *  every probe before it could ever leave the process. */
const DEFAULT_STARTUP_DIGEST_TIMEOUT_MS = 2_000;

function startupDigestTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.ARRA_STARTUP_DIGEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STARTUP_DIGEST_TIMEOUT_MS;
}

/**
 * Called once by `composition.ts`'s `runStartupIndexWork` at real startup,
 * and directly by tests -- this is the whole fix for fix-round finding 4
 * ("profile identity not pinned") AND finding 1 ("the startup digest probe
 * blocks the server for up to Bun's 300s default fetch timeout against a
 * hung Ollama"), kept in one small, independently testable function rather
 * than inline in `composition.ts` so a test can drive it without ever
 * touching `./db`'s legacy FTS index work (`runStartupIndexWork`'s OTHER
 * job) or a real dataset.
 *
 * Two paths, in order:
 *
 * 1. ALREADY PINNED (a real digest was measured on some earlier boot of this
 *    same dataset root, for this same `EMBEDDING_MODEL`): reuse it, with NO
 *    network probe at all. This is the load-bearing property -- once
 *    pinned, this boot cannot possibly disagree with every already-embedded
 *    vector's `embedding_profile`, no matter whether Ollama answers this
 *    time.
 * 2. NOT YET PINNED: a best-effort, BOUNDED probe (`AbortSignal.timeout`,
 *    never the caller's unbounded `fetch` default -- measured at 300007 ms
 *    against a hung endpoint before this fix). A real digest is recorded
 *    AND persisted for every later boot; an unreachable/timed-out Ollama
 *    leaves the digest `unmeasured` for this boot only, exactly like
 *    before this fix, and persists nothing, so the next boot tries again.
 *
 * `ARRA_KNOWLEDGE_DATASET_ROOT` unset or empty (an existing deployment that
 * has not adopted the knowledge dataset) skips pin lookup/persistence
 * entirely -- there is no root to pin against, and the search-chunk kernel
 * is unreachable anyway (`composition.ts`'s `composeKnowledgeAccess` doc).
 */
export async function pinActiveEmbeddingModelDigest(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const datasetRoot = env.ARRA_KNOWLEDGE_DATASET_ROOT;
  const hasRoot = typeof datasetRoot === "string" && datasetRoot.trim().length > 0;

  if (hasRoot) {
    const pinned = readPinnedModelDigest(datasetRoot!, ACTIVE_EMBEDDING_MODEL_NAME);
    if (pinned !== null) {
      configureActiveEmbeddingModelDigest(pinned);
      return;
    }
  }

  const digest = await fetchOllamaModelDigest({
    url: env.OLLAMA_URL,
    signal: AbortSignal.timeout(startupDigestTimeoutMs(env)),
  });
  configureActiveEmbeddingModelDigest(digest);
  if (digest !== null && hasRoot) {
    writePinnedModelDigest(datasetRoot!, ACTIVE_EMBEDDING_MODEL_NAME, digest);
  }
}
