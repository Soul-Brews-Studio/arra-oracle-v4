// Split out of session-link.ts (Nat style: one exported function per file).
// Contract: app/docs/contracts/session-link-v1.md

import { requireClosedObject, requireEnum, type Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import { normalizeTarget, requireTargetKind } from "../contracts/evidence-v1";
import { canonicalize, obj, type JcsValue } from "../contracts/jcs";
import {
  EVIDENCE_REF_KEYS,
  SESSION_RELATIONS,
  type SessionRelation,
} from "./session-link.constants";
import { id } from "./session-link.id";
import { name } from "./session-link.name";
import { parseRequest } from "./session-link.parseRequest";

const CREATE_KEYS = [
  "id",
  "workspace_name",
  "from_session_name",
  "to_session_name",
  "relation",
  "evidence_ref",
  "created_by_peer_name",
] as const;

export type CreateSessionLinkRequest = {
  id: string;
  workspace_name: string;
  from_session_name: string;
  to_session_name: string;
  relation: SessionRelation;
  evidence_ref: string | null;
  created_by_peer_name: string | null;
};

/** Private: used only by parseCreateSessionLink within this file. */
function nullableName(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  return v === null ? null : name(v, tokens);
}

/** Private: used only by parseCreateSessionLink within this file. */
function relation(value: JcsValue | undefined, tokens: Tokens): SessionRelation {
  return requireEnum(value ?? null, SESSION_RELATIONS, tokens);
}

/**
 * `evidence_ref` op: normalize `{target_kind, target}` through the ACCEPTED
 * evidence codec (the same one association's link targets use -- no invented
 * `target_key` column, none exists on `session_links`) and canonicalize the
 * WHOLE wrapper into one canonical JSON text. That text is the entire wire
 * representation, both stored and compared on replay.
 *
 * EXPLICIT null means no evidence attached; omission is `missing_field` --
 * requireClosedObject already enforces that the key is present.
 *
 * Private: used only by parseCreateSessionLink within this file.
 */
function evidenceRefText(value: JcsValue | undefined, tokens: Tokens): string | null {
  const raw = value ?? null;
  if (raw === null) return null;
  const o = requireClosedObject(raw, EVIDENCE_REF_KEYS, tokens);
  const kind = requireTargetKind(o.get("target_kind") ?? null, [...tokens, "target_kind"]);
  const normalized = normalizeTarget(kind, o.get("target") ?? null, [...tokens, "target"]);
  return canonicalize(obj({ target_kind: kind, target: normalized }), tokens);
}

export function parseCreateSessionLink(bytes: Uint8Array): CreateSessionLinkRequest {
  const o = requireClosedObject(parseRequest(bytes), CREATE_KEYS, []);
  const fromSessionName = name(o.get("from_session_name"), ["from_session_name"]);
  const toSessionName = name(o.get("to_session_name"), ["to_session_name"]);
  // Self-link is decidable from the two names alone, so it is refused HERE,
  // by the parser, as a governed ContractError -- never inside the queued
  // turn, where a malformed request would become an owner event and would
  // report the wrong pointer ahead of reference/workspace resolution.
  if (fromSessionName === toSessionName) {
    fail("invalid_value", ["to_session_name"], "must not equal from_session_name");
  }
  return {
    id: id(o.get("id"), ["id"]),
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    from_session_name: fromSessionName,
    to_session_name: toSessionName,
    relation: relation(o.get("relation"), ["relation"]),
    evidence_ref: evidenceRefText(o.get("evidence_ref"), ["evidence_ref"]),
    created_by_peer_name: nullableName(o.get("created_by_peer_name"), ["created_by_peer_name"]),
  };
}
