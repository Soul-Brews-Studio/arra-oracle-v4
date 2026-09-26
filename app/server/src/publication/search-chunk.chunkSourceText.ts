/**
 * The text a revision's chunks are cut from: its title, a blank line, its
 * body. `indexRevisionChunks` chunks exactly this string (`chunkText`), and
 * keyword search re-checks a hit against exactly this string -- one function,
 * so the two can never disagree about what a node's text is.
 */
export function chunkSourceText(title: string, body: string): string {
  return `${title}\n\n${body}`;
}
