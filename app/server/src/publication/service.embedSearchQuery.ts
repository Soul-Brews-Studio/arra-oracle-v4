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
 * `writer_unavailable` (503): "the external model this call depends on did
 * not answer usably; retry later, nothing was corrupted". That was
 * `chat.ts`'s `mapModelFailure` choice when #30 was built; #32 / R9 has since
 * moved chat to its own `model_unavailable` code, and this search keeps
 * `writer_unavailable`, its tested contract, until that alignment is ruled
 * on. The model's own error text never reaches the wire.
 *
 * Runs on the READER, outside any writer queue: a hanging model delays only
 * the search that asked, never a publication.
 */
export async function embedSearchQuery(embedder: QueryEmbedder | undefined, query: string): Promise<number[]> {
  if (embedder === undefined) failPublication("writer_unavailable", "");
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
    return failPublication("writer_unavailable", "");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (
    !Array.isArray(vector) ||
    vector.length !== EMBEDDING_DIMENSION ||
    !vector.every((value) => typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value)))
  ) {
    failPublication("writer_unavailable", "");
  }
  return vector as number[];
}
