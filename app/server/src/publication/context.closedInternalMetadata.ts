import { canonicalize, type JcsObject, type JcsValue } from "../contracts/jcs";
import type { CloseRecord } from "./context.readCloseRecord";

/**
 * The internal_metadata text a K9 close writes (DECISIONS.md R18 D7): every
 * key already stored, plus `closed: {at, by_peer, operation_id, reason}`,
 * as canonical JSON (RFC 8785 key order). Other writers' keys are kept by
 * value; canonical output may respell their numbers, never their meaning.
 */
export function closedInternalMetadata(others: JcsObject, record: CloseRecord): string {
  const next: JcsObject = new Map(others);
  next.set("closed", new Map<string, JcsValue>([
    ["at", record.at],
    ["by_peer", record.by_peer],
    ["operation_id", record.operation_id],
    ["reason", record.reason],
  ]));
  return canonicalize(next);
}
