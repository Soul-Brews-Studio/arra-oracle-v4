import { failPublication } from "./errors";
import { EMBEDDING_DIMENSION } from "./search-chunk.embeddingProfile";

/**
 * `embedding` is `fixed_size_list<float32?>[384]`, NULLABLE.
 *
 * #90 gave this writer a real write path for a populated vector (see
 * `service.writeChunkEmbedding.ts`), so this codec now has authority to
 * validate a populated column, not only refuse one. Accepted: EXPLICIT null
 * (not-yet-embedded is a legitimate state, exactly like every other
 * `storedNullable*` codec here), or EXACTLY `EMBEDDING_DIMENSION` finite
 * float values -- frozen by the column's own physical type, never a
 * per-profile choice (see `search-chunk.embeddingProfile.ts`). Anything else
 * -- wrong length, a non-array, a non-finite element (`NaN`/`Infinity`) -- is
 * refused as stored corruption, not silently truncated or padded.
 *
 * Accepts a real JS array (the shape a caller-built physical row uses), OR
 * an Arrow-vector-like object exposing `toArray()` (the shape a populated
 * `fixed_size_list` column's raw read hands back -- matching
 * `storedTermIds`'s same two-shape acceptance for `list<utf8?>`). MEASURED:
 * unlike `term_ids`'s `toArray()` (a plain `string[]`), this column's
 * `toArray()` hands back a `Float32Array` -- `Array.isArray` on a typed
 * array is `false`, so that shape is checked explicitly rather than folded
 * into the plain-array branch above it.
 */
export function storedEmbedding(value: unknown): number[] | null {
  // EXPLICIT null only -- see `storedNullableTimestamp`. A present-but-
  // `undefined` embedding column is a malformed row, not "not yet embedded".
  if (value === null) return null;
  let items: unknown[];
  if (Array.isArray(value)) {
    items = value;
  } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // A typed array read directly off a stored column (not yet wrapped in
    // an Arrow Vector) -- accepted alongside the `toArray()` shape below.
    items = Array.from(value as unknown as Iterable<unknown>);
  } else if (
    typeof value === "object" &&
    typeof (value as { toArray?: unknown }).toArray === "function"
  ) {
    const raw = (value as { toArray(): unknown }).toArray();
    items = Array.isArray(raw)
      ? raw
      : ArrayBuffer.isView(raw) && !(raw instanceof DataView)
        ? Array.from(raw as unknown as Iterable<unknown>)
        : failPublication("integrity_failure", "");
  } else {
    return failPublication("integrity_failure", "");
  }
  // The dimension is FROZEN BY THE COLUMN TYPE: refused, never truncated or
  // padded to fit.
  if (items.length !== EMBEDDING_DIMENSION) failPublication("integrity_failure", "");
  return items.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) failPublication("integrity_failure", "");
    return item;
  });
}
