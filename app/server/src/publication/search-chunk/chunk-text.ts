/** Fixed chunk size, measured in UTF-16 code units. Simple and deterministic. */
export const CHUNK_SIZE_CHARS = 1000;

/**
 * Fixed-size deterministic chunker, by UTF-16 code units -- EXCEPT that a
 * boundary is never allowed to land inside a surrogate pair.
 *
 * Simple and deterministic on purpose: this is not a semantic chunker, it is
 * the smallest thing that gives every revision a stable, reproducible set of
 * chunk boundaries so the same content always proposes the same chunks. An
 * empty string still produces exactly one (empty) chunk, so a revision with
 * empty derived text still gets one addressable row rather than none.
 *
 * A naive `slice(i, i + size)` can end exactly between a high surrogate and
 * its low surrogate (e.g. an emoji straddling a multiple of 1000). Both
 * halves are individually valid UTF-16 strings, so nothing downstream would
 * reject them at THIS boundary -- but the lone surrogate is not a valid
 * Unicode scalar, and the eventual UTF-8 encode silently replaces it with
 * U+FFFD, corrupting `text` and making `content_hash` (computed on the
 * pre-corruption string) permanently unreproducible from the stored bytes.
 * A split pair must simply never be produced: when the naive boundary would
 * fall on a high surrogate that has a following low surrogate, the boundary
 * is nudged one code unit forward so the pair stays intact in the earlier
 * chunk.
 */
export function chunkText(text: string, size: number = CHUNK_SIZE_CHARS): string[] {
  // `size` is an internal constant, never caller-supplied through a request:
  // a non-positive size would be a programming error in this module, not a
  // rejectable request, so it is asserted rather than mapped to a wire code.
  if (!Number.isInteger(size) || size <= 0) throw new Error("chunkText: size must be a positive integer");
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      // A high surrogate (0xD800-0xDBFF) at the very end of the slice means
      // the boundary split its pair -- the low surrogate is the next unit.
      if (code >= 0xd800 && code <= 0xdbff) end += 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}
