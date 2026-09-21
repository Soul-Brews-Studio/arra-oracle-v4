import { failPublication } from "./errors";

/**
 * `embedding` is `fixed_size_list<float32?>[384]`, NULLABLE. Deliberately
 * accepted as null ONLY: this writer never populates it (embedding is off
 * the authoritative write path -- see the header), so this codec has no
 * authority to invent a float-array validation it never has to serve. A
 * populated column is refused rather than silently passed through, because
 * this module could not vouch for its shape.
 */
export function storedEmbeddingMustBeNull(value: unknown): null {
  // EXPLICIT null only -- see `storedNullableTimestamp`. A present-but-
  // `undefined` embedding column is a malformed row, not "not yet embedded".
  if (value !== null) failPublication("integrity_failure", "");
  return null;
}
