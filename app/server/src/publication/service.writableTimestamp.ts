import { timestampToMicros } from "./rows";

/**
 * Exact UTC-millisecond string to raw storage microseconds.
 *
 * Stays a BigInt all the way to the Arrow builder. A JS Number here would be
 * accepted and then silently corrupt: measured, 253402300799999000 reads back
 * as -4852116231934706.
 */
export function writableTimestamp(text: string): bigint {
  return timestampToMicros(text);
}
