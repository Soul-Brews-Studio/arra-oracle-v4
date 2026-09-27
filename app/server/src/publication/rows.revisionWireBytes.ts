import { utf8ByteLength } from "./rows.utf8ByteLength";

/**
 * Wire byte cost of ONE encoded revision inside the `revisions` array.
 *
 * The budget counts the array only: `[]` is 2 bytes, each element adds its
 * compact JSON length, and every element after the first adds one comma. The
 * enclosing `{node,snapshot_head_revision_id,revisions}` object is excluded by
 * contract, so it is excluded here too.
 */
export function revisionWireBytes(encoded: Record<string, unknown>): number {
  return utf8ByteLength(JSON.stringify(encoded));
}
