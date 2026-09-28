// Shared constants for the session-link split (Nat style: one exported
// function per file). Not functions, so this file is not itself subject to
// the ratchet -- plain values only, mirroring association.constants.ts and
// read-cursor.constants.ts.

export const MAX_REQUEST_BYTES = 1048576;
export const MAX_REQUEST_DEPTH = 64;
export const MAX_NAME_BYTES = 256;

export const MAX_PAGE_LIMIT = 100;
export const MAX_RESULT_WIRE_BYTES = 16 * 1024 * 1024;
/** Bounded reverse-walk visited-set for the directed-relation cycle check. */
export const MAX_CYCLE_VISITED = 1024;

/** Exactly the eight physical columns, in physical order. */
export const SESSION_LINK_FIELDS = [
  "id",
  "workspace_name",
  "from_session_name",
  "to_session_name",
  "relation",
  "evidence_ref",
  "created_by_peer_name",
  "created_at",
] as const;

export const SESSION_RELATIONS = ["continues", "forked_from", "related_to"] as const;
export type SessionRelation = (typeof SESSION_RELATIONS)[number];

/**
 * The two DIRECTED relations subject to the cycle walk. `related_to` is
 * symmetric and exempt -- see `assertSessionLinkAcyclic`'s header and
 * `session-link-v1.md` Decision 4's 2026-09-26 amendment (overnight R7 (#28
 * part), Unit B). A causal loop that mixes `continues` and `forked_from`
 * edges is refused exactly like a same-relation loop: the walk follows
 * EITHER relation, not only the one named on the proposed edge.
 */
export const DIRECTED_SESSION_RELATIONS = ["continues", "forked_from"] as const;

export const SESSION_LINK_DIRECTIONS = ["from", "to"] as const;
export type SessionLinkDirection = (typeof SESSION_LINK_DIRECTIONS)[number];

export const EVIDENCE_REF_KEYS = ["target_kind", "target"] as const;
