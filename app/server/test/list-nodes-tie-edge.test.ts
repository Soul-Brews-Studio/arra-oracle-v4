/**
 * K4 fix round (overnight R18, v3-list slice): an independent Opus verifier
 * found that `listNodes`'s `updated_desc` order can silently DROP a row --
 * not just re-order one -- whenever a millisecond tie in `updated_at`
 * straddles the `MAX_SCANNED_NODES` scan-window edge and the page reads the
 * whole window. The shipped code re-sorts the FETCHED window to
 * `(updated_at desc, id asc)`, but the window itself came from a
 * single-column `ORDER BY updated_at DESC LIMIT n`, which makes no promise
 * about WHICH members of a tie group sitting at the `LIMIT` cutoff are the
 * ones actually fetched -- re-sorting an already-truncated set cannot
 * recover a row that was never fetched, and the boundary predicate for the
 * NEXT page (`updated_at = T AND id > lastId`) then permanently excludes any
 * tied sibling whose id sorts BEFORE the one row that page happened to keep.
 * `lifecycle-v1.md`'s §13 amendment claims the only risk is "a tie wider
 * than `MAX_SCANNED_NODES`"; this file proves that is false -- a 3-way tie
 * under a window of 3 is not "wider" than the window at all, yet two
 * strictly newer rows sharing that same window are enough to trigger it,
 * exactly reproduced below (MEASURED against this worktree's real LanceDB
 * before the fix: the walk terminated at 3 of 5 rows, silently reporting
 * `next_after_id: null` -- "done" -- with two real rows never returned).
 *
 * Own tiny fixture (5 nodes, one dedicated workspace) rather than reusing
 * `list-nodes-term-order.test.ts`'s shared `beta-workspace`: this test needs
 * to control EVERY row `updated_desc` would scan, unfiltered, at the SQL
 * level (the term/type filters in that file only apply AFTER the ordered
 * fetch, so they cannot isolate this test's rows from that file's own).
 *
 * `listNodes`'s 4th argument (`scanWindowForTests`; the 3rd is R18 D3's
 * `requestTimeMs`, unused without `eligible_only`) narrows
 * `MAX_SCANNED_NODES` so the boundary is reachable with 5 published nodes
 * instead of 1000+ -- the same shape the verifier's own scratch repro used
 * ("MAX_SCANNED_NODES lowered to 3"), just as a documented test seam instead
 * of an edited production constant. No production caller ever passes it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createFixture,
  encodeRequest,
  revisionEnvelope,
  runGated,
  type Fixture,
  type SeededWorkspace,
} from "./helpers/publication-fixture";
import { openPrivateConnection } from "../src/publication/service.openPrivateConnection";
import { makeAdapter } from "../src/publication/service.makeAdapter";
import { listNodes as rawListNodes } from "../src/publication/service.listNodes";

const CHILD = new URL("./fixtures/publication-v1/gated-publish.ts", import.meta.url).pathname;
const WS = "tie-edge-workspace";
const CLOCK_MS = Date.parse("2026-09-20T12:00:00.000Z");
/** Narrow enough that 5 published nodes already straddle the edge. */
const SCAN_WINDOW = 3;

let fixture: Fixture;
let seeded: SeededWorkspace;

const nodeId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const revId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

type ListNodesPage = {
  rows: Record<string, unknown>[];
  next_after_id: string | null;
  next_after_updated_at: string | null;
  total: string | null;
};

async function publish(request: unknown, revisionIds: string[], clockMs: number): Promise<void> {
  const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, JSON.stringify({ request, revisionIds, clockMs })]);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 400)}`);
  const outcome = JSON.parse(line);
  if (outcome.ok !== true) throw new Error(`publish failed: ${JSON.stringify(outcome)}`);
}

let newer1: string, newer2: string, tieA: string, tieB: string, tieC: string;

beforeAll(async () => {
  fixture = await createFixture([WS]);
  seeded = fixture.workspaces[WS]!;

  // Two strictly newer rows occupy 2 of the 3-row scan window, leaving room
  // for only ONE more slot -- but the 3-way tie below it has three members,
  // so a single fetch spanning [newer1, newer2, <one of the tie>] cannot
  // include the whole tie group. A wire `limit` equal to the scan window
  // (below) makes the per-id loop consume the WHOLE window in one page, so
  // it never gets a second, tie-only query where the window happens to be
  // exactly the tie's own size (the shape that does NOT reproduce the bug).
  newer1 = nodeId("tieedgenewerone");
  newer2 = nodeId("tieedgenewertwo");
  tieA = nodeId("tieedgetieaaaaa");
  tieB = nodeId("tieedgetiebbbbb");
  tieC = nodeId("tieedgetieccccc");
  // Publish order (and hence the tie's physical/fragment order) is
  // deliberately NOT id-ascending: MEASURED on this worktree's real LanceDB,
  // publishing the tie group as C, B, A is what exposes the engine's
  // arbitrary LIMIT-vs-tie interaction that drops A and B (see this file's
  // header comment). Publishing A, B, C in that order did not reproduce it,
  // because the arbitrary choice inside the truncated window is a real
  // engine behaviour, not a coin flip this test controls directly.
  const plan: [string, number][] = [
    [newer1, CLOCK_MS + 9000],
    [newer2, CLOCK_MS + 8000],
    [tieC, CLOCK_MS + 7000],
    [tieB, CLOCK_MS + 7000],
    [tieA, CLOCK_MS + 7000],
  ];
  for (const [i, [node, clockMs]] of plan.entries()) {
    await publish(
      { operation_id: `op-tie-edge-${i}`, content: revisionEnvelope(WS, seeded, node, { title: `tie-edge-${i}` }) },
      [revId(`tieedgerev${i}`)],
      clockMs,
    );
  }
}, 180_000);

afterAll(async () => {
  await fixture?.cleanup();
});

describe("listNodes: updated_desc tie AT the scan-window edge (K4 fix round)", () => {
  // Verifier note (R18 D3 round): the walk below only discriminates while the
  // `scanWindowForTests` seam actually narrows the window -- with the full
  // 1000-row window every row fits in one fetch and the bug cannot show. This
  // pins the seam itself: a page asking for MORE rows than the narrowed
  // window holds must stop at the window and report a continuation.
  test("the test-only scan window is live: a limit-5 page stops at 3 rows with a continuation cursor", async () => {
    const connection = await openPrivateConnection(fixture.datasetRoot);
    const adapter = makeAdapter(connection, () => {});
    const page = (await rawListNodes(
      adapter,
      encodeRequest({
        workspace_name: WS, after_id: null, limit: 5, include_total: false, include_inactive: false,
        type_term: null, order: "updated_desc", after_updated_at: null,
      }),
      undefined,
      SCAN_WINDOW,
    )) as ListNodesPage;
    expect(page.rows.length).toBe(SCAN_WINDOW);
    expect(page.next_after_id).not.toBeNull();
  });

  test("two newer rows plus a 3-way tie, walked with a page size equal to the scan window: every row comes back exactly once", async () => {
    const connection = await openPrivateConnection(fixture.datasetRoot);
    const adapter = makeAdapter(connection, () => {});

    const seen: string[] = [];
    let afterId: string | null = null;
    let afterUpdatedAt: string | null = null;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 20) throw new Error("pagination did not converge");
      const page = (await rawListNodes(
        adapter,
        encodeRequest({
          workspace_name: WS,
          after_id: afterId,
          limit: SCAN_WINDOW,
          include_total: false,
          include_inactive: false,
          type_term: null,
          order: "updated_desc",
          after_updated_at: afterUpdatedAt,
        }),
        undefined,
        SCAN_WINDOW,
      )) as ListNodesPage;
      seen.push(...page.rows.map((r) => r.id as string));
      if (page.next_after_id === null) break;
      afterId = page.next_after_id;
      afterUpdatedAt = page.next_after_updated_at;
      expect(typeof afterUpdatedAt).toBe("string");
    }

    // The bug this file was written to catch: the walk terminates
    // (`next_after_id: null`, reported as "done") having silently dropped
    // `tieA` and `tieB` -- `seen` comes back as exactly
    // `[newer1, newer2, tieC]`, length 3, before the fix.
    expect(seen).toEqual(expect.arrayContaining([newer1, newer2, tieA, tieB, tieC]));
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });
});
