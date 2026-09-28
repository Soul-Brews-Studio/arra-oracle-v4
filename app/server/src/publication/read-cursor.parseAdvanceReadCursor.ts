// Split out of read-cursor.ts (Nat style: one exported function per file).
// Contract: app/docs/contracts/read-cursor-v1.md

import { requireClosedObject, requireNanoid21, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { name } from "./read-cursor.name";
import { parseRequest } from "./read-cursor.parseRequest";

const ADVANCE_KEYS = [
  "workspace_name",
  "peer_name",
  "session_name",
  "last_read_message_id",
  "expected",
] as const;
const EXPECTED_KEYS = ["last_read_message_id"] as const;

/**
 * `expected` is a TOTAL prior-state guard with three distinct values:
 *   null                      -- the row must be ABSENT
 *   { last_read_message_id: null }  -- present row, null POINTER
 *   { last_read_message_id: N }     -- present row, that exact pointer
 *
 * Absent and present-with-null-pointer are different states, so they cannot
 * share one spelling.
 */
export type AdvanceReadCursorRequest = {
  workspace_name: string;
  peer_name: string;
  session_name: string;
  last_read_message_id: string;
  expected: { last_read_message_id: string | null } | null;
};

/**
 * The declared namespace is message.public_id, which is nanoid21.
 *
 * A legacy decimal message.id such as "42" fails this grammar statically, and
 * deliberately: there is no numeric alias and no fallback lookup, so a request
 * naming the wrong identity is refused before it can reach the store.
 *
 * Private: used only by parseAdvanceReadCursor within this file.
 */
function publicId(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}

export function parseAdvanceReadCursor(bytes: Uint8Array): AdvanceReadCursorRequest {
  const request = requireClosedObject(parseRequest(bytes), ADVANCE_KEYS, []);
  const rawExpected = request.get("expected");
  let expected: { last_read_message_id: string | null } | null = null;
  if (rawExpected !== null) {
    const guard = requireClosedObject(rawExpected ?? null, EXPECTED_KEYS, ["expected"]);
    const pointer = guard.get("last_read_message_id");
    expected = {
      last_read_message_id:
        pointer === null ? null : publicId(pointer, ["expected", "last_read_message_id"]),
    };
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    peer_name: name(request.get("peer_name"), ["peer_name"]),
    session_name: name(request.get("session_name"), ["session_name"]),
    // There is no nullable DESIRED position: a row is created only when a real
    // message is marked read.
    last_read_message_id: publicId(request.get("last_read_message_id"), ["last_read_message_id"]),
    expected,
  };
}
