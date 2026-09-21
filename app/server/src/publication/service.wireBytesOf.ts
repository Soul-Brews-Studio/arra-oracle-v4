import { utf8ByteLength } from "./rows";

/** Compact JSON UTF-8 byte size, for the cumulative response budget. */
export function wireBytesOf(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}
