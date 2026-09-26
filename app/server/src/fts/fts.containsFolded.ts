/**
 * The substring contract every lexical answer is held to: `text` contains `q`
 * after both are lower-cased. This is the post-verification that removes the
 * trigram over-matches (หลงทาง -> the หลงลืม row, ความทรงจำ -> the ความรัก row):
 * sharing a trigram with the query is not containing it.
 */
export function containsFolded(text: unknown, q: string): boolean {
  return typeof text === "string" && text.toLowerCase().includes(q.toLowerCase());
}
