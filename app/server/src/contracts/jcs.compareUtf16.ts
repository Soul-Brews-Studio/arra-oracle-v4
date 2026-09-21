/** UTF-16 code-unit order — what JS `<` on strings already does. Not code points. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
