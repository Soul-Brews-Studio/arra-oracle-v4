/**
 * #88 pagination-boundary isolation proof for listing endpoints.
 *
 * `workspace-isolation.test.ts` (#10) proves every NAME-SCOPED read never
 * crosses a workspace boundary -- but every method it covers takes a caller-
 * supplied identity and can only ever return rows matching THAT identity.
 * A listing endpoint is different: it returns an open-ended set with no
 * caller-supplied identity to check the answer against, paged by a keyset
 * cursor. The leak class #10 cannot exercise is a cursor that straddles a
 * page edge across workspaces -- a predicate that scopes the FIRST page
 * correctly but loses the `workspace_name` clause on the >-than-cursor
 * comparison that builds page two, or a cursor from one workspace that
 * silently resolves inside another.
 *
 * This file seeds TWO workspaces, alpha and beta, with deliberately
 * INTERLEAVED identities: alpha's k-th row sorts strictly between beta's
 * (k-1)-th and k-th, for every k (see `helpers/list-isolation-fixture.ts`).
 * Block-partitioned seeding (all of alpha's rows sorting before all of
 * beta's) cannot exercise a keyset bug -- every page edge would then fall
 * entirely inside one workspace, and a predicate that silently dropped the
 * `workspace_name` clause would still happen to return only the right
 * workspace's rows. Interleaving forces every page edge to straddle a
 * workspace boundary, so a missing or wrong predicate produces a VISIBLE
 * cross-workspace row instead of an accidentally correct answer.
 *
 * Five listing methods are proved, per the #88 contract:
 *
 *   - `listPeers` / `listSessions`  -- { workspace_name, after_name, limit }
 *   - `listNodes`                   -- { workspace_name, after_id, limit, type_term? }
 *   - `listMcpCalls` / `listConnections` -- { workspace_name, after_id, limit, ... }
 *
 * NONE of these methods exist on `origin/main` yet (verified before writing
 * this file: `service.ts` exposes only `close · context · evidence ·
 * publication · taxonomy`, and none of those facades has a `list*` method
 * whose name matches this contract). Every test in this file is written
 * against the CONTRACT, not against any implementation -- this proof was
 * authored with no visibility into the three branches building these
 * methods, on purpose (see the #88 task description). Method names are
 * resolved by SEARCHING every facade the writer service exposes for any of
 * a short alias list (`gated-list-isolation.ts`'s `findMethod`), so a small
 * naming difference on the eventual branch does not require touching this
 * file, and a method that plain does not exist yet is reported
 * `not_implemented` and the corresponding `describe` block is registered
 * with `test.skip`, NEVER reported as a pass.
 *
 * Real gated writer, real target-19 LanceDB dataset, no store mocks.
 * `peers`/`sessions`/`nodes`/`mcp_calls`/`connections` are all seeded
 * through the REAL `DatasetAdapter.append` (the same function the writer
 * service itself is built from) rather than through each table's facade
 * writer -- `mcp_calls` and `connections` have no facade writer at all
 * (SPEC.md §6.3/§7.2: both are written by server-side logging code against
 * the LIVE data directory, not through the gated evidence writer), so raw
 * seeding is the only way to get real, workspace-scoped, interleaved rows
 * into those two tables for this proof. This is real persistence through
 * the real adapter, not a mocked store -- it only skips the FACADE'S
 * business-rule validation (uniqueness checks etc.), which this proof does
 * not need.
 *
 * Every page-size walk for one listing method runs INSIDE the child process
 * as a single `walk` op (see `gated-list-isolation.ts`) rather than one
 * process spawn per page request -- at five methods x five page sizes x two
 * workspaces x up to twenty pages, one-spawn-per-request would be hundreds
 * of process spawns for what is otherwise milliseconds of in-process work.
 * The ENTIRE proof -- seeding, setup verification, and every method's
 * pagination walk -- runs as ONE `ops` array inside ONE gated child
 * invocation.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createFixture, runGated, type Fixture } from "./helpers/publication-fixture";
import {
  interleaved,
  interleavedIds,
  nanoidLike,
  EPOCH_MS_FIELDS,
  workspaceRow,
  peerRow,
  sessionRow,
  nodeRow,
  nodeRevisionRow,
  mcpCallRow,
  connectionRow,
} from "./helpers/list-isolation-fixture";

const CHILD = new URL("./fixtures/list-isolation-v1/core/gated-list-isolation.ts", import.meta.url).pathname;
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const SEED_MS = Date.parse("2026-09-01T00:00:00.000Z");

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
/** Seeded with a bare `workspaces` row and NOTHING else -- the empty-
 *  workspace case (#88 item 6). Not passed through `createFixture`, because
 *  the fixture exporter seeds every workspace it is given two peers and a
 *  session of its own (SPEC-required reference rows for the publication
 *  kernels), which would make it not-actually-empty. */
const GAMMA = "gamma-workspace-empty";

/** Per-workspace row count. Large enough that every page size below leaves
 *  more than one page, small enough that the whole proof runs in one
 *  process invocation in well under a second of real work. */
const N = 20;
/** 1, 2, 3; 5 divides 20 exactly (4 whole pages); 7 does not (7, 7, 6) --
 *  "off-by-one page sizes are where keyset bugs live" (#88). */
const PAGE_SIZES = [1, 2, 3, 5, 7] as const;

/** Per-workspace count of TYPED nodes (own cohort, separate from the N
 *  plain nodes above) for `listNodes`'s `type_term` filter proof. Half get
 *  `type_term: "note"`, half `"decision"` -- so each filtered subset is 10
 *  rows. 1, 2, 3; 5 divides 10 exactly; 3 does not (3, 3, 3, 1). */
const TYPED_N = 20;
const FILTER_PAGE_SIZES = [1, 2, 3, 5] as const;
const TEST_TIMEOUT_MS = 300_000;

type ListSpec = {
  name: string;
  /** Alias list `findMethod` searches for, across every facade. */
  methodNames: string[];
  table: string;
  cursorReqKey: string;
  cursorRespKey: string;
  /** The field on each returned row this proof reads as the row's pagination
   *  identity -- `name` for the two `after_name`-cursored methods, `id` for
   *  the three `after_id`-cursored ones. */
  identityField: string;
  /** Fields every request for this method needs beyond `workspace_name` /
   *  `limit` / the cursor key, spread FIRST so a per-call override still
   *  wins. `listNodes` (v4/list-nodes, b386575), verified by actually
   *  running this file against that branch, treats `include_total` as
   *  REQUIRED, not optional -- its absence is `invalid_request` at
   *  `/include_total`, not "no total in the response". The #88 contract
   *  given for the other four methods says nothing about a required field
   *  beyond workspace_name/cursor/limit, so they default to none.
   *
   *  Also verified by running against v4/list-nodes: closed-key discipline
   *  ("never an implicit default via omission", per that branch's own
   *  commit message) means an OMITTED `type_term` is itself
   *  `invalid_request` -- it must be explicitly `null`, not merely absent,
   *  for every request that isn't filtering. */
  defaultRequest?: Record<string, unknown>;
};

// `include_total: false` is the ORDINARY-request default for every spec,
// verified against the real merged tree (v4/list-merge): `listPeers` and
// `listSessions` (v4/list-context) and `listNodes` (v4/list-nodes)
// independently landed `include_total` as closed-key REQUIRED-but-boolean
// -- "this grammar has no optional keys anywhere else" -- not the
// `include_total?` optional shape #88's original brief described. A
// dedicated op with `include_total: true` is built separately, only where
// `total` itself is under test (see "the total-check ops" below) --
// defaulting every OTHER request to `true` would make the ordinary
// page-purity/chain-walk assertions exercise an extra scoped-count code
// path they have no need of.
const ORDINARY_REQUEST = { include_total: false };

const SPECS: ListSpec[] = [
  {
    name: "listPeers",
    methodNames: ["listPeers", "listPeer"],
    table: "peers",
    cursorReqKey: "after_name",
    cursorRespKey: "next_after_name",
    identityField: "name",
    defaultRequest: ORDINARY_REQUEST,
  },
  {
    name: "listSessions",
    methodNames: ["listSessions", "listSession"],
    table: "sessions",
    cursorReqKey: "after_name",
    cursorRespKey: "next_after_name",
    identityField: "name",
    defaultRequest: ORDINARY_REQUEST,
  },
  {
    name: "listNodes",
    methodNames: ["listNodes", "listNode"],
    table: "nodes",
    cursorReqKey: "after_id",
    cursorRespKey: "next_after_id",
    identityField: "id",
    defaultRequest: { ...ORDINARY_REQUEST, type_term: null },
  },
  {
    // Not merged yet (v4/list-activity is still working, per #88's own
    // tracking) -- no verified request shape to default, so none is
    // guessed here. `findMethod` reports `not_implemented` regardless of
    // what fields this file sends, so this stays skipped either way.
    name: "listMcpCalls",
    methodNames: ["listMcpCalls", "listMcpCall", "listCalls"],
    table: "mcp_calls",
    cursorReqKey: "after_id",
    cursorRespKey: "next_after_id",
    identityField: "id",
  },
  {
    name: "listConnections",
    methodNames: ["listConnections", "listConnection"],
    table: "connections",
    cursorReqKey: "after_id",
    cursorRespKey: "next_after_id",
    identityField: "id",
  },
];

// ── the interleaved seed, generated once ────────────────────────────────────

const peers = interleaved("peer", N);
const sessions = interleaved("sess", N);
// `nodes`/`calls`/`conns` are `id` fields, re-validated as nanoid21 when
// echoed back as a cursor (`interleaved` alone isn't shaped for that --
// see `interleavedIds`'s doc comment).
const nodes = interleavedIds("node", N);
const calls = interleavedIds("call", N);
const conns = interleavedIds("conn", N);
/** A SEPARATE cohort from `nodes` above -- own interleaved ids, each with a
 *  real `node_revisions` row carrying a `type_term` -- so the plain
 *  pagination proof's seed never needs a revision at all. */
const typedNodes = interleavedIds("tnode", TYPED_N);

/** `i % 2 === 0` -> "note", else "decision". Same rule in both workspaces,
 *  so each workspace's `note` and `decision` subsets are both COLLIDING
 *  term NAMES across alpha/beta (both use the reserved `type` vocabulary's
 *  real "note"/"decision" terms) with DIFFERENT term ids per workspace
 *  (`export_publication_fixture.py`'s `scoped_id` is workspace-scoped) --
 *  exactly the leak class named in the #88 follow-up: a name that matches
 *  in both workspaces but resolves to a different id in each. */
const typeTermNameFor = (i: number): "note" | "decision" => (i % 2 === 0 ? "note" : "decision");
const revisionIdFor = (nodeId: string): string => `rev-${nodeId}`;

/** table name -> { a: alpha's own INTERLEAVED identities, b: beta's own }.
 *  Used ONLY to check the interleaving invariant itself -- see
 *  `expectedFor` below for the FULL expected set a listing method must
 *  return, which also includes the fixture's own baseline rows. */
const INTERLEAVED: Record<string, { a: string[]; b: string[] }> = {
  peers,
  sessions,
  nodes,
  mcp_calls: calls,
  connections: conns,
};

/**
 * `createFixture` (SPEC-required reference rows for the publication
 * kernels, see `export_publication_fixture.py`) ALSO seeds every workspace
 * it is given two peers (`<workspace>-author`, `<workspace>-observer`) and
 * one session (`<workspace>-session-1`) of its own, on top of the N
 * interleaved rows this file seeds directly. Those baseline rows are REAL
 * rows in the same table for the same workspace -- a correct `listPeers`/
 * `listSessions` MUST return them too. Peers/sessions populated once
 * `fixture` exists, below.
 *
 * `nodes` is populated with `typedNodes` RIGHT HERE, not after `fixture`:
 * `typedNodes` and the plain `nodes` cohort are two id ranges in the SAME
 * physical `nodes` table for the same workspace, so an unfiltered
 * `listNodes` genuinely returns both -- treating them as separate expected
 * sets was this proof's own bug, caught by actually running it against
 * v4/list-nodes (b386575): the plain cohort's completeness check failed
 * once `typedNodes` also existed in the table, and passed BEFORE that only
 * because of an accidental op-ordering artifact (`typedNodes` was seeded
 * AFTER the plain walk ops in this file's very first draft), not because
 * the expectation was correct.
 */
const BASELINE_EXTRA: Record<string, { a: string[]; b: string[] }> = {
  peers: { a: [], b: [] },
  sessions: { a: [], b: [] },
  nodes: { a: [...typedNodes.a], b: [...typedNodes.b] },
  mcp_calls: { a: [], b: [] },
  connections: { a: [], b: [] },
};

/** The FULL set of identities a listing method must return for this
 *  workspace and table: the interleaved seed plus the fixture's own
 *  baseline rows, sorted. */
const expectedFor = (spec: ListSpec, workspace: string): string[] => {
  const pair = INTERLEAVED[spec.table]!;
  const extra = BASELINE_EXTRA[spec.table]!;
  if (workspace === ALPHA) return [...pair.a, ...extra.a].sort();
  if (workspace === BETA) return [...pair.b, ...extra.b].sort();
  return [];
};

// ── every op, built up front, indexed by a readable key ─────────────────────

type Op = Record<string, unknown>;
const ops: Op[] = [];
const opIndex: Record<string, number> = {};
const push = (key: string, spec: Op): void => {
  if (opIndex[key] !== undefined) throw new Error(`duplicate op key: ${key}`);
  opIndex[key] = ops.length;
  ops.push(spec);
};

push("seed.workspaces", {
  kind: "seed",
  table: "workspaces",
  epochMsFields: EPOCH_MS_FIELDS.workspaces,
  rows: [workspaceRow(GAMMA, "ws-gamma-empty-id-0000001", SEED_MS)],
});
push("seed.peers", {
  kind: "seed",
  table: "peers",
  epochMsFields: EPOCH_MS_FIELDS.peers,
  rows: [
    ...peers.a.map((name, i) => peerRow(ALPHA, nanoidLike(`pa${i}`), name, SEED_MS + i)),
    ...peers.b.map((name, i) => peerRow(BETA, nanoidLike(`pb${i}`), name, SEED_MS + i)),
  ],
});
push("seed.sessions", {
  kind: "seed",
  table: "sessions",
  epochMsFields: EPOCH_MS_FIELDS.sessions,
  rows: [
    ...sessions.a.map((name, i) => sessionRow(ALPHA, nanoidLike(`sa${i}`), name, SEED_MS + i)),
    ...sessions.b.map((name, i) => sessionRow(BETA, nanoidLike(`sb${i}`), name, SEED_MS + i)),
  ],
});
push("seed.nodes", {
  kind: "seed",
  table: "nodes",
  epochMsFields: EPOCH_MS_FIELDS.nodes,
  rows: [
    ...nodes.a.map((id, i) => nodeRow(ALPHA, id, SEED_MS + i, revisionIdFor(id))),
    ...nodes.b.map((id, i) => nodeRow(BETA, id, SEED_MS + i, revisionIdFor(id))),
  ],
});
// This cohort's `node_revisions` (needs the fixture's own `type` vocabulary
// term ids) are pushed further down, alongside the typed cohort's -- see
// "seed.plain_node_revisions" near "seed.node_revisions" below.
push("seed.mcp_calls", {
  kind: "seed",
  table: "mcp_calls",
  epochMsFields: EPOCH_MS_FIELDS.mcp_calls,
  rows: [
    ...calls.a.map((id, i) => mcpCallRow(ALPHA, id, SEED_MS + i)),
    ...calls.b.map((id, i) => mcpCallRow(BETA, id, SEED_MS + i)),
  ],
});
push("seed.connections", {
  kind: "seed",
  table: "connections",
  epochMsFields: EPOCH_MS_FIELDS.connections,
  rows: [
    ...conns.a.map((id, i) => connectionRow(ALPHA, id, SEED_MS + i)),
    ...conns.b.map((id, i) => connectionRow(BETA, id, SEED_MS + i)),
  ],
});

push("count.peers.alpha", { kind: "count", table: "peers", predicate: `workspace_name = '${ALPHA}'` });
push("count.peers.beta", { kind: "count", table: "peers", predicate: `workspace_name = '${BETA}'` });
push("count.sessions.alpha", { kind: "count", table: "sessions", predicate: `workspace_name = '${ALPHA}'` });
// `nodes` is counted AFTER the typed cohort below is also seeded (see
// "count.nodes.alpha"/".beta" further down) -- this table holds both
// cohorts, so a count taken here would only see the plain one.
push("count.mcp_calls.alpha", { kind: "count", table: "mcp_calls", predicate: `workspace_name = '${ALPHA}'` });
push("count.connections.alpha", { kind: "count", table: "connections", predicate: `workspace_name = '${ALPHA}'` });

// The standard per-spec walk/cross/empty ops are pushed FURTHER DOWN, after
// EVERY seed op including the `type_term` cohort's -- see the comment next
// to that push for why: it is load-bearing, not cosmetic.

// ── run the entire proof once, before any test reads a result ───────────────

let fixture: Fixture;
let combined: Record<string, any>;

async function driveOnce(): Promise<Record<string, any>> {
  const result = await runGated(
    fixture.datasetRoot,
    CHILD,
    [fixture.datasetRoot, JSON.stringify({ ops, clockMs: CLOCK_MS })],
    { deadlineMs: TEST_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(`gated-list-isolation child exited ${result.code}: ${result.stderr.slice(0, 4000)}`);
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) {
    throw new Error(`gated-list-isolation child produced no output: ${result.stderr.slice(0, 4000)}`);
  }
  return JSON.parse(line);
}

fixture = await createFixture([ALPHA, BETA]);
BASELINE_EXTRA.peers = {
  a: fixture.workspaces[ALPHA]!.peer_names,
  b: fixture.workspaces[BETA]!.peer_names,
};
BASELINE_EXTRA.sessions = {
  a: [fixture.workspaces[ALPHA]!.session_name],
  b: [fixture.workspaces[BETA]!.session_name],
};

// ── `listNodes` `type_term` filter proof (v4/list-nodes, b386575) ───────────
//
// Pushed here, AFTER `createFixture`, because the term/vocabulary ids used
// come from the fixture's own SPEC-required reserved `type` vocabulary
// (`term_ids.type.note` / `.decision`) -- real, workspace-scoped, and
// already colliding by NAME across alpha/beta with DIFFERENT ids, which is
// exactly the seeding this leak class needs, for free.

const termIdFor = (workspace: string, name: "note" | "decision"): string =>
  fixture.workspaces[workspace]!.term_ids.type[name].id;
const vocabularyIdFor = (workspace: string): string => fixture.workspaces[workspace]!.vocabulary_ids.type;
const typeTermFor = (workspace: string, name: "note" | "decision") => ({
  name,
  termId: termIdFor(workspace, name),
  vocabularyId: vocabularyIdFor(workspace),
});

// The PLAIN cohort's own revisions -- every revision needs EXACTLY ONE type
// term (see `nodeRevisionRow`'s doc comment), even though this cohort is
// never `type_term`-filtered. Arbitrarily "note" throughout; which term
// doesn't matter here, only that there is exactly one.
push("seed.plain_node_revisions", {
  kind: "seed",
  table: "node_revisions",
  epochMsFields: EPOCH_MS_FIELDS.node_revisions,
  rows: [
    ...nodes.a.map((id, i) => nodeRevisionRow(ALPHA, revisionIdFor(id), id, typeTermFor(ALPHA, "note"), SEED_MS + i)),
    ...nodes.b.map((id, i) => nodeRevisionRow(BETA, revisionIdFor(id), id, typeTermFor(BETA, "note"), SEED_MS + i)),
  ],
});

push("seed.typed_nodes", {
  kind: "seed",
  table: "nodes",
  epochMsFields: EPOCH_MS_FIELDS.nodes,
  rows: [
    ...typedNodes.a.map((id, i) => nodeRow(ALPHA, id, SEED_MS + i, revisionIdFor(id))),
    ...typedNodes.b.map((id, i) => nodeRow(BETA, id, SEED_MS + i, revisionIdFor(id))),
  ],
});
push("seed.node_revisions", {
  kind: "seed",
  table: "node_revisions",
  epochMsFields: EPOCH_MS_FIELDS.node_revisions,
  rows: [
    ...typedNodes.a.map((id, i) =>
      nodeRevisionRow(ALPHA, revisionIdFor(id), id, typeTermFor(ALPHA, typeTermNameFor(i)), SEED_MS + i),
    ),
    ...typedNodes.b.map((id, i) =>
      nodeRevisionRow(BETA, revisionIdFor(id), id, typeTermFor(BETA, typeTermNameFor(i)), SEED_MS + i),
    ),
  ],
});
push("count.node_revisions.alpha", { kind: "count", table: "node_revisions", predicate: `workspace_name = '${ALPHA}'` });
push("count.node_revisions.beta", { kind: "count", table: "node_revisions", predicate: `workspace_name = '${BETA}'` });
push("count.nodes.alpha", { kind: "count", table: "nodes", predicate: `workspace_name = '${ALPHA}'` });
push("count.nodes.beta", { kind: "count", table: "nodes", predicate: `workspace_name = '${BETA}'` });

const LIST_NODES = SPECS.find((s) => s.name === "listNodes")!;
for (const workspace of [ALPHA, BETA]) {
  for (const term of ["note", "decision"] as const) {
    for (const pageSize of FILTER_PAGE_SIZES) {
      push(`listNodes.typeTerm.${workspace}.${term}.${pageSize}`, {
        kind: "walk",
        methodNames: LIST_NODES.methodNames,
        // `include_total: true` HERE, overriding the spec's ordinary
        // `false` default: this walk is what item 5's `type_term` case
        // checks -- `total` must come back `null` (deliberately, per
        // v4/list-nodes: no native scoped count exists for a JSON-embedded
        // field, and it refuses to fake one with a full scan), which is
        // only observable if `include_total` was actually requested.
        baseRequest: {
          ...LIST_NODES.defaultRequest,
          workspace_name: workspace,
          limit: pageSize,
          type_term: term,
          include_total: true,
        },
        cursorReqKey: LIST_NODES.cursorReqKey,
        cursorRespKey: LIST_NODES.cursorRespKey,
        maxPages: N + TYPED_N + 10,
      });
    }
  }
}
// "if the filter ever accepts an id": beta, filtered by ALPHA's real
// `note` term id (a string that is emphatically not a term NAME) -- must
// not resolve to anything, and must not leak alpha's rows.
push("listNodes.typeTerm.idNotName", {
  kind: "call",
  methodNames: LIST_NODES.methodNames,
  request: {
    ...LIST_NODES.defaultRequest,
    workspace_name: BETA,
    limit: TYPED_N,
    [LIST_NODES.cursorReqKey]: null,
    type_term: termIdFor(ALPHA, "note"),
  },
});

// ── the standard per-spec walk/cross/empty ops, for ALL FIVE methods ────────
//
// Pushed HERE -- last, after every seed op above, including the `type_term`
// cohort's -- and not where they were first drafted (right after the early
// seed ops, before `createFixture`). `ops` execute in ARRAY ORDER inside ONE
// child process: pushing these early meant listNodes' own PLAIN walk ran
// BEFORE `seed.plain_node_revisions` existed in the array, so it examined
// nodes with a `current_revision_id` pointing at a revision that had not
// been seeded YET -- an `integrity_failure` this proof caused by its own
// op ordering, not a bug in what was under test. Caught by actually running
// this file against v4/list-nodes: the isolated worktree copy failed with
// "revision null for headId" on the very first plain node examined, every
// run, deterministically -- not flaky, which is what made it traceable.
for (const spec of SPECS) {
  for (const workspace of [ALPHA, BETA]) {
    for (const pageSize of PAGE_SIZES) {
      push(`${spec.name}.walk.${workspace}.${pageSize}`, {
        kind: "walk",
        methodNames: spec.methodNames,
        baseRequest: { ...spec.defaultRequest, workspace_name: workspace, limit: pageSize },
        cursorReqKey: spec.cursorReqKey,
        cursorRespKey: spec.cursorRespKey,
        maxPages: N + TYPED_N + 10,
      });
    }
  }
  // Cross-workspace cursor: alpha's own next-cursor, submitted under beta.
  push(`${spec.name}.cross`, {
    kind: "cross",
    methodNames: spec.methodNames,
    cursorReqKey: spec.cursorReqKey,
    cursorRespKey: spec.cursorRespKey,
    // Closed-key discipline (verified against v4/list-nodes): the cursor
    // key must be explicitly present -- `null` for "no cursor yet" -- never
    // simply omitted, same as every other request this file builds.
    sourceRequest: { ...spec.defaultRequest, workspace_name: ALPHA, limit: 3, [spec.cursorReqKey]: null },
    targetWorkspaceName: BETA,
  });
  // Empty workspace: exists (seeded above), owns zero rows in this table.
  push(`${spec.name}.empty`, {
    kind: "call",
    methodNames: spec.methodNames,
    request: { ...spec.defaultRequest, workspace_name: GAMMA, limit: 10, [spec.cursorReqKey]: null },
  });
  // A SEPARATE walk, `include_total: true`, only for item 5 ("total, when
  // present, counts only the requested workspace"). Kept apart from the
  // ordinary page-purity walks above (which default `include_total:
  // false`) so THIS is the only place that extra scoped-count path runs.
  for (const workspace of [ALPHA, BETA]) {
    push(`${spec.name}.totalWalk.${workspace}`, {
      kind: "walk",
      methodNames: spec.methodNames,
      baseRequest: { ...spec.defaultRequest, workspace_name: workspace, limit: 3, include_total: true },
      cursorReqKey: spec.cursorReqKey,
      cursorRespKey: spec.cursorRespKey,
      maxPages: N + TYPED_N + 10,
    });
  }
}

combined = await driveOnce();

const op = (key: string): any => {
  const i = opIndex[key];
  if (i === undefined) throw new Error(`unknown op key: ${key}`);
  return combined[`op${i}`];
};

afterAll(async () => {
  await fixture.cleanup();
});

// ── setup verification: the interleaved seed genuinely landed ───────────────

describe("setup: the interleaved seed genuinely exists, per table, per workspace, before any listing method runs", () => {
  test("every seed op wrote real rows through the real DatasetAdapter", () => {
    for (const key of [
      "seed.workspaces",
      "seed.peers",
      "seed.sessions",
      "seed.nodes",
      "seed.plain_node_revisions",
      "seed.mcp_calls",
      "seed.connections",
      "seed.typed_nodes",
      "seed.node_revisions",
    ]) {
      const result = op(key);
      expect(result.ok, `${key}: ${JSON.stringify(result).slice(0, 500)}`).toBe(true);
    }
  });

  test("raw counts match the expected full set per workspace -- interleaved seed plus the fixture's own baseline rows, never 2x (block-seeded) and never 0 (seed silently dropped)", () => {
    expect(op("count.peers.alpha").value).toBe(N + BASELINE_EXTRA.peers!.a.length);
    expect(op("count.peers.beta").value).toBe(N + BASELINE_EXTRA.peers!.b.length);
    expect(op("count.sessions.alpha").value).toBe(N + BASELINE_EXTRA.sessions!.a.length);
    // `nodes` holds BOTH cohorts (plain + typed) in the same table.
    expect(op("count.nodes.alpha").value).toBe(N + BASELINE_EXTRA.nodes!.a.length);
    expect(op("count.nodes.beta").value).toBe(N + BASELINE_EXTRA.nodes!.b.length);
    expect(op("count.mcp_calls.alpha").value).toBe(N);
    expect(op("count.connections.alpha").value).toBe(N);
    // Both cohorts' revisions are in this table by the time this count runs
    // (plain cohort's revisions are seeded earlier, typed cohort's later,
    // this count op later still): N plain + TYPED_N typed.
    expect(op("count.node_revisions.alpha").value).toBe(N + TYPED_N);
    expect(op("count.node_revisions.beta").value).toBe(N + TYPED_N);
  });

  test("identities genuinely interleave: alpha[k] < beta[k] < alpha[k+1] for every k, in every table", () => {
    for (const pair of Object.values(INTERLEAVED)) {
      for (let i = 0; i < N; i += 1) {
        expect(pair.a[i]! < pair.b[i]!, `a[${i}] < b[${i}]`).toBe(true);
        if (i + 1 < N) {
          expect(pair.b[i]! < pair.a[i + 1]!, `b[${i}] < a[${i + 1}]`).toBe(true);
        }
      }
    }
  });
});

// ── per-method pagination-boundary isolation ─────────────────────────────────

for (const spec of SPECS) {
  const probe = op(`${spec.name}.walk.${ALPHA}.1`);
  const pending = probe?.ok === false && probe?.code === "not_implemented";

  describe(`${spec.name}: pagination-boundary isolation (#88)`, () => {
    if (pending) {
      test.skip(
        `${spec.name} is not on this branch yet (tried ${JSON.stringify((probe as any)?.triedNames)} across facades ${JSON.stringify((probe as any)?.facades)}) -- written against the #88 contract, pending implementation`,
        () => {},
      );
      return;
    }

    for (const workspace of [ALPHA, BETA]) {
      const expected = expectedFor(spec, workspace);
      const other = expectedFor(spec, workspace === ALPHA ? BETA : ALPHA);

      for (const pageSize of PAGE_SIZES) {
        test(`page size ${pageSize}, ${workspace}: every page pure, chain complete and non-duplicating, terminates`, () => {
          const result = op(`${spec.name}.walk.${workspace}.${pageSize}`);
          expect(result.ok, `${spec.name} ${workspace} @${pageSize}: ${JSON.stringify(result).slice(0, 500)}`).toBe(true);

          // 4. Terminates: `next_*` becomes null exactly when the set is
          //    exhausted -- never a cursor that returns an empty page forever.
          expect(result.terminated, `${spec.name} ${workspace} @${pageSize} did not terminate within ${N + 5} pages`).toBe(
            true,
          );

          const pages: Array<Record<string, unknown>[]> = result.pages;
          const flat: string[] = [];
          for (const [pageNo, page] of pages.entries()) {
            for (const row of page) {
              const identity = String(row[spec.identityField]);
              // 1. Every page is pure: never a row from the OTHER workspace.
              expect(
                other.includes(identity),
                `${spec.name} ${workspace} @${pageSize} page ${pageNo}: leaked "${identity}" from the other workspace`,
              ).toBe(false);
              flat.push(identity);
            }
          }

          // 2. Complete and non-duplicating: SET equality against the
          //    workspace's own expected identities, not a count.
          expect(new Set(flat).size, `${spec.name} ${workspace} @${pageSize}: duplicate row across pages`).toBe(
            flat.length,
          );
          expect([...flat].sort()).toEqual([...expected].sort());
        });
      }

      test(`${workspace}: total, when the response carries one, counts only this workspace's own rows`, () => {
        const result = op(`${spec.name}.totalWalk.${workspace}`);
        expect(result.ok, `${spec.name} ${workspace} totalWalk: ${JSON.stringify(result).slice(0, 500)}`).toBe(true);
        const totals: unknown[] = (result.totals as unknown[]).filter((t) => t !== null && t !== undefined);
        if (totals.length === 0) {
          // This implementation's response shape carries no `total` field.
          // That is a legitimate contract choice -- nothing to check.
          return;
        }
        const combinedCount = expected.length + other.length;
        for (const total of totals) {
          // `listNodes` (v4/list-nodes) returns `total` as a STRING --
          // this codebase's Int64-as-text convention throughout (matches
          // `revision_no`, `duration_ms`, etc. elsewhere) -- so compare by
          // value, not by JS type.
          expect(String(total), `${spec.name} ${workspace} total`).toBe(String(expected.length));
          expect(
            String(total),
            `${spec.name} ${workspace} total counted BOTH workspaces (a scan with no workspace predicate)`,
          ).not.toBe(String(combinedCount));
        }
      });
    }

    test("a cursor from alpha, submitted under beta's workspace name, never returns an alpha row and never corrupts beta's own set", () => {
      const result = op(`${spec.name}.cross`);
      expect(result.ok, `${spec.name} cross: ${JSON.stringify(result).slice(0, 500)}`).toBe(true);
      expect(result.sourceCursor, "alpha's first page must itself have had a next cursor to test with").not.toBeNull();

      const target = result.target;
      const alphaSet = expectedFor(spec, ALPHA);
      const betaSet = expectedFor(spec, BETA);

      if (target.ok === false) {
        // A refusal is an acceptable contract for a foreign cursor -- STATE
        // it rather than force one interpretation.
        console.log(`[#88 contract] ${spec.name} REFUSES a cross-workspace cursor: ${JSON.stringify(target).slice(0, 300)}`);
        return;
      }

      const rows: Record<string, unknown>[] = target.value.rows ?? [];
      for (const row of rows) {
        const identity = String(row[spec.identityField]);
        expect(alphaSet.includes(identity), `${spec.name}: alpha's cursor under beta returned alpha's own row "${identity}"`).toBe(
          false,
        );
        expect(
          betaSet.includes(identity),
          `${spec.name}: alpha's cursor under beta returned "${identity}", which belongs to NEITHER workspace`,
        ).toBe(true);
      }
      console.log(
        `[#88 contract] ${spec.name} treats a foreign cursor as a plain key in the target workspace's own space (returned ${rows.length} of beta's own rows, zero of alpha's)`,
      );
    });

    test("an empty workspace (exists, owns zero rows in this table) returns an empty page and a null cursor -- never someone else's rows", () => {
      const result = op(`${spec.name}.empty`);
      expect(result.ok, `${spec.name} empty-workspace call: ${JSON.stringify(result).slice(0, 500)}`).toBe(true);
      const value = result.value;
      expect(value.rows ?? []).toEqual([]);
      expect(value[spec.cursorRespKey] ?? null).toBeNull();
    });

    // ── listNodes only: `type_term` filter (v4/list-nodes, b386575) ─────────
    //
    // `type_term` is a NAME match against `node_revisions.term_snapshot_json`
    // (`deriveNodeType`). Both workspaces here use the SAME reserved `type`
    // vocabulary's real "note"/"decision" term NAMES but DIFFERENT term ids
    // (`scoped_id` is workspace-scoped) -- a colliding name, different id,
    // by construction. Filtering widens the scan to `MAX_SCANNED_NODES`
    // candidates and `next_after_id` points at the last node EXAMINED, not
    // the last MATCHED -- both are exercised for free by re-running the same
    // purity/completeness walk with a filter applied.
    if (spec.name === "listNodes") {
      for (const workspace of [ALPHA, BETA]) {
        for (const term of ["note", "decision"] as const) {
          // The PLAIN cohort (never itself under test here) is ALSO tagged
          // "note" throughout (see "seed.plain_node_revisions" -- "which
          // term doesn't matter, only that there is exactly one"). A
          // `type_term: "note"` filter genuinely, correctly matches it too
          // -- found by running this file against v4/list-nodes: the first
          // draft's `expected` set only counted the typed cohort and
          // (wrongly) flagged the plain cohort's real "note" rows as a
          // leak.
          const plainThisWorkspace = term === "note" ? (workspace === ALPHA ? nodes.a : nodes.b) : [];
          const plainOtherWorkspace = term === "note" ? (workspace === ALPHA ? nodes.b : nodes.a) : [];

          const expected = [
            ...(workspace === ALPHA ? typedNodes.a : typedNodes.b).filter((_, i) => typeTermNameFor(i) === term),
            ...plainThisWorkspace,
          ];
          const other = [
            ...(workspace === ALPHA ? typedNodes.b : typedNodes.a).filter((_, i) => typeTermNameFor(i) === term),
            ...plainOtherWorkspace,
          ];
          // The OTHER term's rows, same workspace -- a filter that matched
          // on vocabulary but not term name would leak these instead. The
          // plain cohort is never "decision", so it never contributes here.
          const sameWorkspaceOtherTerm = (workspace === ALPHA ? typedNodes.a : typedNodes.b).filter(
            (_, i) => typeTermNameFor(i) !== term,
          );

          for (const pageSize of FILTER_PAGE_SIZES) {
            test(`type_term="${term}", page size ${pageSize}, ${workspace}: filtered page is pure and complete, next_after_id does not skip or re-scan across the boundary`, () => {
              const result = op(`listNodes.typeTerm.${workspace}.${term}.${pageSize}`);
              expect(result.ok, `listNodes typeTerm ${workspace}/${term} @${pageSize}: ${JSON.stringify(result).slice(0, 500)}`).toBe(
                true,
              );
              expect(
                result.terminated,
                `listNodes typeTerm ${workspace}/${term} @${pageSize} did not terminate (next_after_id -- the last EXAMINED node, not the last matched -- looping instead of advancing past a run of non-matching nodes is exactly this failure mode)`,
              ).toBe(true);

              const pages: Array<Record<string, unknown>[]> = result.pages;
              const flat: string[] = [];
              for (const [pageNo, page] of pages.entries()) {
                for (const row of page) {
                  const identity = String(row.id);
                  expect(
                    other.includes(identity),
                    `listNodes typeTerm ${workspace}/${term} @${pageSize} page ${pageNo}: leaked "${identity}" -- a node from the OTHER workspace whose type term NAME happens to collide`,
                  ).toBe(false);
                  expect(
                    sameWorkspaceOtherTerm.includes(identity),
                    `listNodes typeTerm ${workspace}/${term} @${pageSize} page ${pageNo}: "${identity}" belongs to this workspace's OWN "${term === "note" ? "decision" : "note"}" cohort -- the filter matched vocabulary but not term name`,
                  ).toBe(false);
                  flat.push(identity);
                }
              }

              // Filtered pagination completeness: the boundary moved (wider
              // scan window, cursor = last examined) but the SET returned
              // must still be exactly this workspace's own matching subset,
              // no row skipped by an over-eager cursor, no row repeated by
              // a cursor that failed to advance.
              expect(new Set(flat).size, "duplicate row across filtered pages").toBe(flat.length);
              expect([...flat].sort()).toEqual([...expected].sort());

              // `include_total: true` + `type_term` deliberately returns
              // `total: null` (v4/list-nodes) -- never a count that could
              // itself leak the other workspace's size.
              for (const total of result.totals as unknown[]) {
                expect(total, `listNodes typeTerm ${workspace}/${term} @${pageSize}: total must be null when type_term is set`).toBeNull();
              }
            });
          }
        }
      }

      test('type_term given an ALPHA term ID (not a name) while listing BETA resolves to nothing -- never alpha rows, never a crash treating an id as a name match', () => {
        const result = op("listNodes.typeTerm.idNotName");
        expect(result.ok, `listNodes typeTerm id-not-name: ${JSON.stringify(result).slice(0, 500)}`).toBe(true);
        const rows: Record<string, unknown>[] = result.value.rows ?? [];
        const alphaAll = [...typedNodes.a];
        for (const row of rows) {
          const identity = String(row.id);
          expect(alphaAll.includes(identity), `listNodes: alpha's term id, used as type_term under beta, returned alpha's own row "${identity}"`).toBe(
            false,
          );
        }
      });
    }
  });
}
