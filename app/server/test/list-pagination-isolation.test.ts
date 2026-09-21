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
  EPOCH_MS_FIELDS,
  workspaceRow,
  peerRow,
  sessionRow,
  nodeRow,
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
};

const SPECS: ListSpec[] = [
  {
    name: "listPeers",
    methodNames: ["listPeers", "listPeer"],
    table: "peers",
    cursorReqKey: "after_name",
    cursorRespKey: "next_after_name",
    identityField: "name",
  },
  {
    name: "listSessions",
    methodNames: ["listSessions", "listSession"],
    table: "sessions",
    cursorReqKey: "after_name",
    cursorRespKey: "next_after_name",
    identityField: "name",
  },
  {
    name: "listNodes",
    methodNames: ["listNodes", "listNode"],
    table: "nodes",
    cursorReqKey: "after_id",
    cursorRespKey: "next_after_id",
    identityField: "id",
  },
  {
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
const nodes = interleaved("node", N);
const calls = interleaved("call", N);
const conns = interleaved("conn", N);

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
 * `listSessions` MUST return them too. Populated once `fixture` exists,
 * below; empty for `nodes`/`mcp_calls`/`connections`, which the exporter
 * never touches (`export_publication_fixture.py`: "writes no nodes and no
 * revisions", and mcp_calls/connections are outside its scope entirely).
 */
const BASELINE_EXTRA: Record<string, { a: string[]; b: string[] }> = {
  peers: { a: [], b: [] },
  sessions: { a: [], b: [] },
  nodes: { a: [], b: [] },
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
    ...peers.a.map((name, i) => peerRow(ALPHA, `peer-a-id-${i}`, name, SEED_MS + i)),
    ...peers.b.map((name, i) => peerRow(BETA, `peer-b-id-${i}`, name, SEED_MS + i)),
  ],
});
push("seed.sessions", {
  kind: "seed",
  table: "sessions",
  epochMsFields: EPOCH_MS_FIELDS.sessions,
  rows: [
    ...sessions.a.map((name, i) => sessionRow(ALPHA, `sess-a-id-${i}`, name, SEED_MS + i)),
    ...sessions.b.map((name, i) => sessionRow(BETA, `sess-b-id-${i}`, name, SEED_MS + i)),
  ],
});
push("seed.nodes", {
  kind: "seed",
  table: "nodes",
  epochMsFields: EPOCH_MS_FIELDS.nodes,
  rows: [
    ...nodes.a.map((id, i) => nodeRow(ALPHA, id, SEED_MS + i)),
    ...nodes.b.map((id, i) => nodeRow(BETA, id, SEED_MS + i)),
  ],
});
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
push("count.nodes.alpha", { kind: "count", table: "nodes", predicate: `workspace_name = '${ALPHA}'` });
push("count.nodes.beta", { kind: "count", table: "nodes", predicate: `workspace_name = '${BETA}'` });
push("count.mcp_calls.alpha", { kind: "count", table: "mcp_calls", predicate: `workspace_name = '${ALPHA}'` });
push("count.connections.alpha", { kind: "count", table: "connections", predicate: `workspace_name = '${ALPHA}'` });

for (const spec of SPECS) {
  for (const workspace of [ALPHA, BETA]) {
    for (const pageSize of PAGE_SIZES) {
      push(`${spec.name}.walk.${workspace}.${pageSize}`, {
        kind: "walk",
        methodNames: spec.methodNames,
        baseRequest: { workspace_name: workspace, limit: pageSize },
        cursorReqKey: spec.cursorReqKey,
        cursorRespKey: spec.cursorRespKey,
        maxPages: N + 5,
      });
    }
  }
  // Cross-workspace cursor: alpha's own next-cursor, submitted under beta.
  push(`${spec.name}.cross`, {
    kind: "cross",
    methodNames: spec.methodNames,
    cursorReqKey: spec.cursorReqKey,
    cursorRespKey: spec.cursorRespKey,
    sourceRequest: { workspace_name: ALPHA, limit: 3 },
    targetWorkspaceName: BETA,
  });
  // Empty workspace: exists (seeded above), owns zero rows in this table.
  push(`${spec.name}.empty`, {
    kind: "call",
    methodNames: spec.methodNames,
    request: { workspace_name: GAMMA, limit: 10, [spec.cursorReqKey]: null },
  });
}

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
    for (const key of ["seed.workspaces", "seed.peers", "seed.sessions", "seed.nodes", "seed.mcp_calls", "seed.connections"]) {
      const result = op(key);
      expect(result.ok, `${key}: ${JSON.stringify(result).slice(0, 500)}`).toBe(true);
    }
  });

  test("raw counts match the expected full set per workspace -- interleaved seed plus the fixture's own baseline rows, never 2x (block-seeded) and never 0 (seed silently dropped)", () => {
    expect(op("count.peers.alpha").value).toBe(N + BASELINE_EXTRA.peers!.a.length);
    expect(op("count.peers.beta").value).toBe(N + BASELINE_EXTRA.peers!.b.length);
    expect(op("count.sessions.alpha").value).toBe(N + BASELINE_EXTRA.sessions!.a.length);
    expect(op("count.nodes.alpha").value).toBe(N);
    expect(op("count.nodes.beta").value).toBe(N);
    expect(op("count.mcp_calls.alpha").value).toBe(N);
    expect(op("count.connections.alpha").value).toBe(N);
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
        const result = op(`${spec.name}.walk.${workspace}.1`);
        expect(result.ok).toBe(true);
        const totals: unknown[] = (result.totals as unknown[]).filter((t) => t !== null && t !== undefined);
        if (totals.length === 0) {
          // This implementation's response shape carries no `total` field.
          // That is a legitimate contract choice -- nothing to check.
          return;
        }
        const combinedCount = expected.length + other.length;
        for (const total of totals) {
          expect(total, `${spec.name} ${workspace} total`).toBe(expected.length);
          expect(
            total,
            `${spec.name} ${workspace} total counted BOTH workspaces (a scan with no workspace predicate)`,
          ).not.toBe(combinedCount);
        }
      });
    }

    test("a cursor from alpha, submitted under beta's workspace name, never returns an alpha row and never corrupts beta's own set", () => {
      const result = op(`${spec.name}.cross`);
      expect(result.ok).toBe(true);
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
  });
}
