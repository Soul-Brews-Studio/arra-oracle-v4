/** UTF-8 byte length of a string, for the wire budget. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
