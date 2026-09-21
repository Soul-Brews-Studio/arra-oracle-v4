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
 * for the five tables this proof writes into directly: `peers`, `sessions`,
 * `nodes`, `mcp_calls`, `connections`, plus a bare `workspaces` row for the
 * empty-workspace case. Every row is written through the REAL
 * `DatasetAdapter.append` (see `gated-list-isolation.ts`'s `seed` op) -- this
 * file only describes what those rows contain.
 */

export type Interleaved = { a: string[]; b: string[] };

/** Zero-padded, fixed width, so ordinary string comparison == insertion
 *  order == numeric order. `perWorkspace` identities each, alternating
 *  a[0] < b[0] < a[1] < b[1] < ... < a[n-1] < b[n-1]. */
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

/** `epochMsFields` per table: which columns the child converts from a plain
 *  epoch-ms number to raw storage microseconds before calling
 *  `DatasetAdapter.append`. `mcp_calls.created_at` is a physical INT64
 *  column (SPEC.md §6.3), not a timestamp -- it stays a plain number. */
export const EPOCH_MS_FIELDS: Record<string, string[]> = {
  workspaces: ["created_at"],
  peers: ["created_at"],
  sessions: ["created_at"],
  nodes: ["created_at", "updated_at"],
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
 *  column on `nodes`. */
export function nodeRow(workspace: string, id: string, createdAtMs: number): Record<string, unknown> {
  return {
    id,
    workspace_name: workspace,
    current_revision_id: null,
    created_at: createdAtMs,
    updated_at: createdAtMs,
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
