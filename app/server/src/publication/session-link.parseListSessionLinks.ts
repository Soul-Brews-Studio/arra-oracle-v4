// Split out of session-link.ts (Nat style: one exported function per file).
// Contract: app/docs/contracts/session-link-v1.md

import { requireClosedObject, requireEnum } from "../contracts/common";
import { fail } from "../contracts/errors";
import {
  MAX_PAGE_LIMIT,
  SESSION_LINK_DIRECTIONS,
  type SessionLinkDirection,
} from "./session-link.constants";
import { id } from "./session-link.id";
import { name } from "./session-link.name";
import { parseRequest } from "./session-link.parseRequest";

const LIST_KEYS = ["workspace_name", "session_name", "direction", "cursor", "limit"] as const;

export type ListSessionLinksRequest = {
  workspace_name: string;
  session_name: string;
  direction: SessionLinkDirection;
  cursor: string | null;
  limit: number;
};

export function parseListSessionLinks(bytes: Uint8Array): ListSessionLinksRequest {
  const o = requireClosedObject(parseRequest(bytes), LIST_KEYS, []);
  const direction = requireEnum(o.get("direction") ?? null, SESSION_LINK_DIRECTIONS, ["direction"]);
  const rawCursor = o.get("cursor");
  const cursor = (rawCursor ?? null) === null ? null : id(rawCursor, ["cursor"]);

  const rawLimit = o.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }

  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    direction,
    cursor,
    limit: rawLimit,
  };
}
