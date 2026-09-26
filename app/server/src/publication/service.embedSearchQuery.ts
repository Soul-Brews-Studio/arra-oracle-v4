import { failPublication } from "./errors";
import { EMBEDDING_DIMENSION } from "./search-chunk";
import { type QueryEmbedder } from "./service.types";

/** How long a semantic search waits for its query vector. */
export const QUERY_EMBED_TIMEOUT_MS = 30_000;

/**
 * Embed one search query through the injected embedder.
 *
 * Any failure -- no embedder composed, a thrown or rejected call, no answer
 * within `QUERY_EMBED_TIMEOUT_MS`, a vector that is not exactly
 * `EMBEDDING_DIMENSION` finite float32-representable numbers -- is
 * `model_unavailable` (503): "the external model this call depends on did
 * not answer usably; retry later, nothing was corrupted". That was
 * `writer_unavailable` (`chat.ts`'s `mapModelFailure` choice when #30 was
 * built) until overnight R21 (docs/overnight/DECISIONS.md) aligned it with
 * #32 / R9's chat code: no chat model configured or reachable is the SAME
 * kind of outcome as no query embedder configured or reachable, so both now
 * answer the one closed `model_unavailable` code. The model's own error text
 * never reaches the wire.
 *
 * Runs on the READER, outside any writer queue: a hanging model delays only
 * the search that asked, never a publication.
 */
export async function embedSearchQuery(embedder: QueryEmbedder | undefined, query: string): Promise<number[]> {
  if (embedder === undefined) failPublication("model_unavailable", "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let vector: unknown;
  try {
    vector = await Promise.race([
      embedder.embed(query),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("query embed timed out")), QUERY_EMBED_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return failPublication("model_unavailable", "");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (
    !Array.isArray(vector) ||
    vector.length !== EMBEDDING_DIMENSION ||
    !vector.every((value) => typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value)))
  ) {
    failPublication("model_unavailable", "");
  }
  return vector as number[];
}
