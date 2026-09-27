import { requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { MAX_CONTEXT_ITEMS } from "./chat";
import { name } from "./context.name";
import { parseRequest } from "./context.parseRequest";
import { REQUESTER_KEY, requesterPeerName } from "./context.requesterPeerName";

export type GetRepresentationRequest = {
  workspace_name: string;
  /** #87 / R3: optional; null means the audit:read operator view. */
  requester_peer_name: string | null;
  observer_peer_name: string;
  subject_peer_name: string;
  max_items: number;
};

const KEYS = ["workspace_name", "observer_peer_name", "subject_peer_name", "max_items"];

/**
 * D3b `getRepresentation` (DESIGN.md §12 "REPRESENTATION observer + subject").
 * Both perspective names are REQUIRED: a representation is one directed
 * `observer -> subject` view, and "any observer" would be exactly the merged
 * global profile §12 forbids. `requester_peer_name` is optional on the same
 * terms as `listMessages` (#87 / R3), and `max_items` shares chat's bound.
 */
export function parseGetRepresentation(bytes: Uint8Array): GetRepresentationRequest {
  const raw = parseRequest(bytes);
  const o = requireClosedObject(raw, raw.has(REQUESTER_KEY) ? [...KEYS, REQUESTER_KEY] : KEYS, []);
  const maxItems = o.get("max_items");
  if (typeof maxItems !== "number" || !Number.isInteger(maxItems)) fail("invalid_type", ["max_items"], "expected integer");
  if (maxItems < 1 || maxItems > MAX_CONTEXT_ITEMS) fail("invalid_value", ["max_items"], `expected 1..${MAX_CONTEXT_ITEMS}`);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    requester_peer_name: requesterPeerName(o),
    observer_peer_name: name(o.get("observer_peer_name"), ["observer_peer_name"]),
    subject_peer_name: name(o.get("subject_peer_name"), ["subject_peer_name"]),
    max_items: maxItems,
  };
}
