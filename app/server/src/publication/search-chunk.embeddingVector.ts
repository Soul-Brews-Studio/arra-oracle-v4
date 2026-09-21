import { requireArray, type Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import type { JcsValue } from "../contracts/jcs";
import { EMBEDDING_DIMENSION } from "./search-chunk.embeddingProfile";

/**
 * The request-grammar embedding vector: EXACTLY `EMBEDDING_DIMENSION` finite
 * JSON numbers. The dimension is FROZEN BY THE COLUMN TYPE (see
 * `search-chunk.embeddingProfile.ts`), so a request declaring any other
 * length is refused here, at the boundary, before it ever reaches the
 * writer -- never truncated or padded to fit.
 *
 * `NaN` and `Infinity` are not valid JSON, but `parseStrictBytes` decodes
 * bytes, not JS values, so this still checks `Number.isFinite` explicitly
 * rather than trusting the wire encoding to have excluded them.
 */
export function embeddingVector(value: JcsValue | undefined, tokens: Tokens): number[] {
  const items = requireArray(value ?? null, tokens);
  if (items.length !== EMBEDDING_DIMENSION) {
    fail("invalid_value", tokens, `embedding dimension is frozen at ${EMBEDDING_DIMENSION}`);
  }
  return items.map((item, index) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      fail("invalid_type", [...tokens, index], "expected a finite number");
    }
    return item as number;
  });
}
