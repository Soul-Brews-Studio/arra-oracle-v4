import { CHUNK_SIZE_CHARS } from "./search-chunk.chunkText";

/**
 * The fold every chunk-local comparison uses: lower-case, then final sigma
 * (ς) written as σ.
 *
 * `containsFolded` lower-cases the WHOLE text, where Σ becomes ς or σ
 * depending on the letter after it -- which, at a chunk boundary, lives in the
 * NEXT chunk. Final sigma is the only context-dependent mapping in
 * `toLowerCase()` (the rest of SpecialCasing's conditions are
 * locale-specific), so once ς and σ are one letter the fold is
 * per-character: the fold of a text is the fold of its chunks, joined, and
 * anything the whole-text check can find is still findable chunk by chunk.
 */
const fold = (text: string) => text.toLowerCase().replaceAll("ς", "σ");

/**
 * Length of the longest proper prefix of `pattern` that `text` ends with
 * (Knuth-Morris-Pratt over UTF-16 code units: O(|text| + |pattern|)). A full
 * occurrence inside `text` is not a prefix hit; the caller checks it first.
 */
function suffixPrefixOverlap(text: string, pattern: string): number {
  if (pattern.length < 2) return 0;
  const failure = new Int32Array(pattern.length);
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = failure[k - 1]!;
    if (pattern[i] === pattern[k]) k++;
    failure[i] = k;
  }
  let k = 0;
  for (let i = Math.max(0, text.length - pattern.length + 1); i < text.length; i++) {
    while (k > 0 && text[i] !== pattern[k]) k = failure[k - 1]!;
    if (text[i] === pattern[k]) k++;
    if (k === pattern.length) k = failure[k - 1]!;
  }
  return k;
}

const reverse = (text: string) => text.split("").reverse().join("");

/**
 * Whether one chunk can hold ANY part of an occurrence of `query` in its
 * revision's text -- the cheap, per-chunk pre-filter keyword search runs
 * before it reads anything.
 *
 * An occurrence of `query` in the text either lies inside one chunk, or spans
 * several: the first of those ENDS with a proper prefix of the query, the last
 * STARTS with a proper suffix, and any between them lie wholly INSIDE the
 * query. Only a real seam counts: a chunk has one before it when its
 * `chunkIndex` is above 0, and one after it only when it is full length --
 * `chunkText` cuts every `chunkSize` code units (one more to keep a surrogate
 * pair whole), so a shorter chunk is the last. Every chunk an occurrence
 * touches therefore passes (with the fold above, case-insensitively), so
 * dropping the rest loses no answer; it only saves reading the head revisions
 * of candidates that merely share a trigram with the query (หลงทาง vs
 * หลงลืม). It is not the answer: the hit is still re-checked against the
 * whole head text, which is what decides.
 */
export function chunkMayHoldQuery(chunk: string, chunkIndex: bigint, query: string, chunkSize: number = CHUNK_SIZE_CHARS): boolean {
  const text = fold(chunk);
  const q = fold(query);
  if (text.includes(q)) return true;
  const before = chunkIndex > 0n;
  const after = chunk.length >= chunkSize;
  return (
    (after && suffixPrefixOverlap(text, q) > 0) ||
    (before && suffixPrefixOverlap(reverse(text), reverse(q)) > 0) ||
    (before && after && q.includes(text))
  );
}
