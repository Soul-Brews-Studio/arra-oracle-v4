import { failPublication } from "./errors";

/**
 * The closed status set. NOT a stored enum -- `status` is `utf8 NOT NULL`
 * with no enum in the physical schema; this closed set is this module's own
 * decision. `pending` is the only value this module's own writer ever
 * produces; `ready` and `failed` are reserved for the (not-yet-implemented)
 * embed step and are validated here so a future writer and this reader agree
 * on the vocabulary. A differently-configured writer could legally store a
 * fourth value, which is why this check is integrity_failure, not a
 * request-grammar rejection.
 */
export const CHUNK_STATUSES = ["pending", "ready", "failed"] as const;
export type ChunkStatus = (typeof CHUNK_STATUSES)[number];

export function storedStatus(value: unknown): ChunkStatus {
  if (typeof value !== "string" || !(CHUNK_STATUSES as readonly string[]).includes(value)) {
    failPublication("integrity_failure", "");
  }
  return value as ChunkStatus;
}
