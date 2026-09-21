import { utf8ByteLength } from "../rows";

/** Encoded JSON size of one result row, in UTF-8 BYTES. A string length would
 *  under-count every non-ASCII character. */
export function rowWireBytes(row: Record<string, unknown>): number {
  return utf8ByteLength(JSON.stringify(row));
}
