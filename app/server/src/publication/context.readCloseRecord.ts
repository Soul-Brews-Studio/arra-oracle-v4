import { parseStrict, type JcsObject, type JcsValue } from "../contracts/jcs";
import { failPublication } from "./errors";

/** One session's close, as K9 records it in `sessions.internal_metadata.closed`. */
export type CloseRecord = { at: string; by_peer: string | null; operation_id: string; reason: string };

const RECORD_KEYS = ["at", "by_peer", "operation_id", "reason"];

const text = (value: JcsValue | undefined): string => {
  if (typeof value !== "string" || value.length === 0) failPublication("integrity_failure", "");
  return value;
};

/**
 * Read a session's STORED internal_metadata for K9 (DECISIONS.md R18 D7):
 * the close record, if any, and every other key another writer stored, so a
 * close can be recorded beside them without losing one.
 *
 * Stored state, never request input: anything that is not a JSON object, a
 * `closed` value that is not exactly `{at, by_peer, operation_id, reason}`,
 * or an `at` that is not an exact UTC millisecond timestamp is
 * `integrity_failure` at the root -- never repaired, never overwritten.
 */
export function readCloseRecord(stored: string | null): { others: JcsObject; closed: CloseRecord | null } {
  if (stored === null) return { others: new Map(), closed: null };
  let parsed: JcsValue;
  try {
    parsed = parseStrict(stored);
  } catch {
    return failPublication("integrity_failure", "");
  }
  if (!(parsed instanceof Map)) return failPublication("integrity_failure", "");
  const others: JcsObject = new Map([...parsed].filter(([key]) => key !== "closed"));
  const closed = parsed.get("closed");
  if (closed === undefined) return { others, closed: null };
  if (!(closed instanceof Map) || closed.size !== RECORD_KEYS.length || !RECORD_KEYS.every((key) => closed.has(key))) {
    return failPublication("integrity_failure", "");
  }
  const at = text(closed.get("at"));
  const millis = Date.parse(at);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== at) failPublication("integrity_failure", "");
  const byPeer = closed.get("by_peer");
  return {
    others,
    closed: {
      at,
      by_peer: byPeer === null ? null : text(byPeer),
      operation_id: text(closed.get("operation_id")),
      reason: text(closed.get("reason")),
    },
  };
}
