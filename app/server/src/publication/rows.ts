/**
 * Physical row <-> wire encoding for target Node and NodeRevision.
 *
 * Two rules drive everything here.
 *
 * First, Int64 columns never become JS numbers. `revision_no` and
 * `schema_version` are physical Int64, so they travel as canonical decimal
 * STRINGS and are held as BigInt in between. A Number would silently round
 * past 2^53 and there would be no error to notice.
 *
 * Second, timestamps are read from Arrow's RAW microsecond storage, never
 * through a row accessor. The accessor divides by 1000 into a lossy Number
 * before we can inspect it, so a sub-millisecond value would already be gone
 * by the time we looked. We check divisibility on the raw BigInt and refuse a
 * non-zero remainder rather than rounding it away.
 *
 * This file is a re-export barrel: each function below moved VERBATIM into
 * `rows.<fn>.ts` (Nat style, one exported function per file, named after the
 * file). Kept here so importers do not churn. Barrel only -- the split files
 * import each other and rows.constants.ts directly, never through this file.
 */

export {
  NODE_FIELDS,
  REVISION_FIELDS,
  type NodeField,
  type RevisionField,
  INT64_MIN,
  INT64_MAX,
  EMPTY_ARRAY_BYTES,
  MAX_CHAIN_WIRE_BYTES,
  MAX_CHAIN_ROWS,
} from "./rows.constants";
export { toInt64Text } from "./rows.toInt64Text";
export { parseInt64Text } from "./rows.parseInt64Text";
export { microsToTimestamp } from "./rows.microsToTimestamp";
export { timestampToMicros } from "./rows.timestampToMicros";
export { encodeRevisionRow } from "./rows.encodeRevisionRow";
export { encodeNodeRow } from "./rows.encodeNodeRow";
export { utf8ByteLength } from "./rows.utf8ByteLength";
export { revisionWireBytes } from "./rows.revisionWireBytes";
