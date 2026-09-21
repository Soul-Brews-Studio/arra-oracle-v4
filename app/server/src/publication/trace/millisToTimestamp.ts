import { failPublication } from "../errors";
import { MIN_EPOCH_MS, MAX_EPOCH_MS } from "./constants";

/** RAW storage milliseconds to an exact UTC millisecond wire string. */
export function millisToTimestamp(millis: bigint): string {
  if (millis < MIN_EPOCH_MS || millis > MAX_EPOCH_MS) failPublication("integrity_failure", "");
  const text = new Date(Number(millis)).toISOString();
  if (Date.parse(text) !== Number(millis)) failPublication("integrity_failure", "");
  return text;
}
