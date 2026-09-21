/**
 * Seed helpers for the #88 pagination-boundary isolation proof.
 *
 * `interleaved` is the heart of the seeding strategy: workspace A's k-th
 * identity sorts strictly between workspace B's (k-1)-th and k-th identities,
 * for every k. Two workspaces seeded name-block-partitioned (all of A's
 * names before all of B's) can never exercise a keyset bug -- every page
 * boundary would fall either entirely inside A or entirely inside B, and a
 * predicate that silently dropped the workspace clause would still happen to
 * return only the right workspace's rows on a same-workspace walk. Forcing
 * every single page edge, at every page size, to straddle a workspace
 * boundary is what makes a missing or wrong `workspace_name` predicate
 * visible instead of accidentally correct.
 *
 * Row builders mirror the physical column sets in
 * `app/migrate-py/src/arra_migrate/target_v1/*.py` (the target-19 manifest)
 * for the six tables this proof writes into directly: `peers`, `sessions`,
 * `nodes`, `node_revisions`, `mcp_calls`, `connections`, plus a bare
 * `workspaces` row for the empty-workspace case. Every row is written
 * through the REAL `DatasetAdapter.append` (see `gated-list-isolation.ts`'s
 * `seed` op) -- this file only describes what those rows contain.
 */

import { createHash } from "node:crypto";

export type Interleaved = { a: string[]; b: string[] };

/** Zero-padded, fixed width, so ordinary string comparison == insertion
 *  order == numeric order. `perWorkspace` identities each, alternating
 *  a[0] < b[0] < a[1] < b[1] < ... < a[n-1] < b[n-1]. For NAME fields
 *  (`listPeers`/`listSessions`' `after_name`) -- no format constraint on a
 *  `name` column. For an `id` field used as a keyset cursor, use
 *  `interleavedIds` instead: it echoes back as `after_*` on the NEXT
 *  request, and this codebase re-validates a cursor id's shape.
 */
export function interleaved(prefix: string, perWorkspace: number): Interleaved {
  let n = 0;
  const next = () => {
    n += 1;
    return `${prefix}${String(n).padStart(5, "0")}`;
  };
  const a: string[] = [];
  const b: string[] = [];
  for (let i = 0; i < perWorkspace; i += 1) {
    a.push(next());
    b.push(next());
  }
  return { a, b };
}

/** nanoid(21) alphabet, `[A-Za-z0-9_-]{21}` -- verified against
 *  `service.constants.ts`'s `NANOID21` by actually running this proof
 *  against v4/list-nodes (b386575): `listNodes` re-validates a non-null
 *  `after_id` through `requireNodeId` on every page after the first, so a
 *  proof-only id shape that isn't nanoid21 fails as `invalid_request` the
 *  moment the SECOND page is requested, not at seed time. Same padding
 *  trick as `interleaved`, right-padded with `_` to exactly 21 characters
 *  so ordinary string comparison still == insertion order. */
export function interleavedIds(prefix: string, perWorkspace: number): Interleaved {
  let n = 0;
  const next = () => {
    n += 1;
    const body = `${prefix}${String(n).padStart(5, "0")}`;
    if (body.length > 21) throw new Error(`interleavedIds: "${body}" exceeds nanoid21's 21 characters`);
    return body.padEnd(21, "_");
  };
  const a: string[] = [];
  const b: string[] = [];
  for (let i = 0; i < perWorkspace; i += 1) {
    a.push(next());
    b.push(next());
  }
  return { a, b };
}

/** `epochMsFields` per table: which columns the child converts from a plain
 *  epoch-ms number to raw storage microseconds before calling
 *  `DatasetAdapter.append`. `mcp_calls.created_at` is a physical INT64
 *  column (SPEC.md §6.3), not a timestamp -- it stays a plain number. */
export const EPOCH_MS_FIELDS: Record<string, string[]> = {
  workspaces: ["created_at"],
  peers: ["created_at"],
  sessions: ["created_at"],
  nodes: ["created_at", "updated_at"],
  node_revisions: ["created_at"],
  connections: ["first_seen", "last_seen"],
  mcp_calls: [],
};

export function workspaceRow(workspace: string, id: string, createdAtMs: number): Record<string, unknown> {
  return {
    id,
    name: workspace,
    created_at: createdAtMs,
    h_metadata: null,
    internal_metadata: null,
    configuration: null,
    mission: null,
  };
}

/** `id` need not sort -- only `name` is the pagination identity for
 *  `listPeers`. */
export function peerRow(workspace: string, id: string, name: string, createdAtMs: number): Record<string, unknown> {
  return {
    id,
    name,
    workspace_name: workspace,
    h_metadata: null,
    internal_metadata: null,
    configuration: null,
    created_at: createdAtMs,
  };
}

export function sessionRow(workspace: string, id: string, name: string, createdAtMs: number): Record<string, unknown> {
  return {
    id,
    name,
    workspace_name: workspace,
    is_active: true,
    h_metadata: null,
    internal_metadata: null,
    configuration: null,
    created_at: createdAtMs,
  };
}

/** `id` IS the pagination identity for `listNodes` -- no separate name
 *  column on `nodes`. `currentRevisionId` is null for the plain pagination
 *  proof (no revision needed) and set for the `type_term` filter proof,
 *  where it must resolve to a real `node_revisions` row -- see
 *  `nodeRevisionRow` below. */
export function nodeRow(
  workspace: string,
  id: string,
  createdAtMs: number,
  currentRevisionId: string | null = null,
): Record<string, unknown> {
  return {
    id,
    workspace_name: workspace,
    current_revision_id: currentRevisionId,
    created_at: createdAtMs,
    updated_at: createdAtMs,
  };
}

/**
 * A minimal but PHYSICALLY VALID `node_revisions` row, carrying exactly one
 * reserved-`type`-vocabulary entry in `term_snapshot_json` -- the only shape
 * `deriveNodeType()` (`app/server/src/publication/service.deriveNodeType.ts`)
 * accepts: exactly one entry whose `vocabulary_name_snapshot === "type"`.
 * `list_nodes`'s `type_term` filter (v4/list-nodes, `b386575`) matches
 * against that entry's `term_name_snapshot`.
 *
 * Written through the real `DatasetAdapter.append`, bypassing the
 * publication facade's own validation (digest recomputation, ancestry
 * checks, exactly-one-type enforcement at write time) the same way every
 * other raw seed in this file does -- nothing on the LISTING read path this
 * proof exercises re-verifies `content_digest` or ancestry, so a
 * syntactically valid but not independently meaningful digest is enough.
 *
 * `typeTerm` is NOT optional -- this proof's first attempt let the PLAIN
 * pagination cohort (never `type_term`-filtered, so nothing seemed to
 * check it) carry an empty `term_snapshot_json` ("[]"). Running against
 * v4/list-nodes (b386575) found the real bug in that assumption:
 * `type_term`-filtered scans examine EVERY node in the id-ordered window
 * regardless of workspace-internal cohort, so a plain-cohort node sharing
 * the same `nodes` table as a filtered scan's typed cohort gets its
 * revision decoded by `deriveNodeType` too -- which requires EXACTLY ONE
 * `type`-vocabulary entry and reports `integrity_failure` for zero, the
 * SAME reserved-vocabulary invariant `taxonomy`'s own `required=True` on
 * `type` enforces at write time. A revision with no type is not a
 * legitimate lighter-weight row; it is exactly the corruption the real
 * write path never produces. `current_revision_id` itself has the same
 * story one level up: `listNodes` treats ANY node whose
 * `current_revision_id` does not resolve to a real `node_revisions` row as
 * stored corruption and refuses the ENTIRE call, not just that row.
 */
export function nodeRevisionRow(
  workspace: string,
  id: string,
  nodeId: string,
  typeTerm: { name: "note" | "decision"; termId: string; vocabularyId: string },
  createdAtMs: number,
): Record<string, unknown> {
  const termSnapshotJson = JSON.stringify([
    {
      term_id: typeTerm.termId,
      vocabulary_id: typeTerm.vocabularyId,
      vocabulary_name_snapshot: "type",
      term_name_snapshot: typeTerm.name,
      label_snapshot: null,
      position: "0",
    },
  ]);
  return {
    id,
    workspace_name: workspace,
    node_id: nodeId,
    revision_no: 1,
    base_revision_id: null,
    operation_id: id,
    title: "seed.list-isolation-proof title",
    body: "seed.list-isolation-proof body",
    body_format: "markdown",
    fields: "{}",
    author_peer_name: null,
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: null,
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: null,
    created_at: createdAtMs,
    schema_version: 1,
    canonical_version: "arra-revision/v1",
    content_digest: createHash("sha256").update(id).digest("hex"),
    term_snapshot_json: termSnapshotJson,
    link_snapshot_json: "[]",
    h_metadata: null,
    internal_metadata: null,
  };
}

export function mcpCallRow(workspace: string, id: string, createdAtMs: number): Record<string, unknown> {
  return {
    id,
    workspace_name: workspace,
    session_name: null,
    peer_name: null,
    tool: "seed.list-isolation-proof",
    status: "ok",
    duration_ms: 1,
    h_metadata: null,
    internal_metadata: null,
    created_at: createdAtMs,
  };
}

/** `id` is a proof-only sortable shape here, not the production
 *  `'<method>:<principal>'` convention (SPEC.md §7.2) -- nothing on the
 *  read side this proof exercises depends on that format. */
export function connectionRow(workspace: string, id: string, createdAtMs: number): Record<string, unknown> {
  return {
    id,
    workspace_name: workspace,
    method: "bearer",
    principal: id,
    label: "seed.list-isolation-proof",
    user_agent: null,
    remote_ip: null,
    first_seen: createdAtMs,
    last_seen: createdAtMs,
    requests: 1,
    tool_calls: 1,
    last_tool: null,
  };
}
