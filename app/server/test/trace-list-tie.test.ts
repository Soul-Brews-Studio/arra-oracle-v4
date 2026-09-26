// K5 fix round 2 (docs/overnight/V3-PARITY.md §5; overnight R18): the keyset
// cursor must stay complete when a `created_at` TIE straddles the end of the
// `MAX_SCANNED_TRACES` (1000) scan window. Written BEFORE the fix -- RED on
// `service.listTraces.ts` at 2e4e894: the window was ordered by `created_at`
// alone with `LIMIT 1000`, so which rows of a tie group at the window's tail
// made it in was the storage engine's choice, not the kernel's. When a walk
// ran off such a window, the cursor became `(tail.created_at, tail.id)` and
// the next predicate (`created_at < X OR (created_at = X AND id > Y)`)
// excluded, forever, every tied row that had not fit and had a smaller id --
// a silent loss, with the last page still claiming `coverage:"full"`.
//
// Two shapes, one workspace each:
// - STRADDLE: 998 distinct newer rows, then a tie group of TIE_SIZE rows at
//   one millisecond that the 1000-row window can only partly hold. Only a
//   `query_contains` walk runs off a full window (an unfiltered page fills
//   at `limit` <= 100 long before the window's tail), so the needle is on
//   the tied rows alone.
// - WIDE: a single tie group LARGER than the whole window. Here even an
//   unfiltered walk is affected: the first window is some 1000 of the group,
//   sorted by id in JS, so its first page is not the group's true first 100.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openEvidenceReader } from "../src/publication/service";
import { createFixture, runGated, type Fixture } from "./helpers/publication-fixture";
import { traceId } from "./helpers/trace-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const STRADDLE = "ws-tie-straddle";
const WIDE = "ws-tie-wide";
const CHILD = new URL("./fixtures/trace-v1/core/gated-trace.ts", import.meta.url).pathname;
// Newer than the fixture's own baseline trace (SEED_EPOCH_MS, 1_789_862_400_000),
// so the baseline is the OLDEST row in each workspace, never inside a tie.
const BASE = 1_790_000_000_000;
const NEWER = 998;
const TIE_SIZE = 8;
const WIDE_SIZE = 1003;
const WALK_TIMEOUT_MS = testTimeout(30_000); // same sizing as trace-list-cursor.test.ts

// Fixed-width seeds, as in trace-list-cursor.test.ts: `traceId` pads with
// trailing zeros, so seeds of different lengths could collide once padded.
const newerId = (i: number) => traceId(`new${i.toString().padStart(4, "0")}`);
const tieId = (k: number) => traceId(`tie${k.toString().padStart(4, "0")}`);
const wideId = (i: number) => traceId(`wid${i.toString().padStart(4, "0")}`);

type Row = { id: string; created_at: string; derived_from_count: number };
type Page = {
  rows: Row[];
  next_after_created_at: string | null;
  next_after_id: string | null;
  has_more: boolean;
  coverage: "full" | "partial";
};
type ListTracesReader = { listTraces(b: Uint8Array): Promise<Page> };

let fixture: Fixture;
let reader: Awaited<ReturnType<typeof openEvidenceReader>>;
const context = () => reader.context as unknown as ListTracesReader;

const req = (workspace: string, overrides: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      workspace_name: workspace, parent_id: null, prev_id: null, depth: null, query_contains: null,
      after_created_at: null, after_id: null, limit: 100, ...overrides,
    }),
  );

const raw = (workspace: string, id: string, createdAt: number, query: string) => ({
  id, workspace_name: workspace, query, depth: "0", status: "open",
  created_at_millis: createdAt.toString(10), updated_at_millis: createdAt.toString(10),
});

/** Walk every page from the start; fail on the first id seen twice. */
async function walk(workspace: string, overrides: Record<string, unknown>): Promise<{ ids: string[]; pages: Page[] }> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const pages: Page[] = [];
  let after_created_at: string | null = null;
  let after_id: string | null = null;
  for (let n = 0; n < 60; n++) {
    const page = await context().listTraces(req(workspace, { ...overrides, after_created_at, after_id }));
    pages.push(page);
    for (const row of page.rows) {
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
      ids.push(row.id);
    }
    if (!page.has_more) return { ids, pages };
    expect(page.next_after_created_at !== null && page.next_after_id !== null).toBe(true);
    after_created_at = page.next_after_created_at;
    after_id = page.next_after_id;
  }
  throw new Error(`${workspace}: walk did not terminate within 60 pages`);
}

beforeAll(async () => {
  fixture = await createFixture([STRADDLE, WIDE]);
  // Tied rows are planted in DESCENDING id order on purpose: an engine that
  // keeps the first-inserted rows of a tie at the LIMIT boundary then keeps
  // the LARGEST ids, which is exactly the shape that strands the smaller ones
  // behind the cursor. The fixed kernel must not care either way.
  const rows = [
    ...Array.from({ length: NEWER }, (_, i) => raw(STRADDLE, newerId(i), BASE + 100 + i, `plain newer row ${i}`)),
    ...Array.from({ length: TIE_SIZE }, (_, k) => TIE_SIZE - 1 - k).map((k) =>
      raw(STRADDLE, tieId(k), BASE, `tied needle-substring row ${k}`),
    ),
    ...Array.from({ length: WIDE_SIZE }, (_, i) => WIDE_SIZE - 1 - i).map((i) =>
      raw(WIDE, wideId(i), BASE, i % 100 === 7 ? `wide needle-substring row ${i}` : `wide row ${i}`),
    ),
  ];
  const seeded = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops: [{ facade: "harness", method: "insertRawTraces", request: { rows } }] }),
  ]);
  if (seeded.code !== 0) throw new Error(`gated-trace.ts exited ${seeded.code}: ${seeded.stderr.slice(0, 1500)}`);
  const line = seeded.stdout.trim().split("\n").filter(Boolean).at(-1);
  const parsed = JSON.parse(line ?? "{}");
  if (parsed.op0?.ok !== true) throw new Error(`bulk plant failed: ${JSON.stringify(parsed.op0)}`);
  reader = await openEvidenceReader(fixture.datasetRoot);
}, testTimeout(120_000));

afterAll(async () => {
  await fixture?.cleanup();
});

describe("K5 kernel: a created_at tie never straddles the scan window's tail unseen", () => {
  test("STRADDLE, query_contains: every tied row comes back exactly once, in id order", async () => {
    const { ids } = await walk(STRADDLE, { query_contains: "needle-substring", limit: 10 });
    const want = Array.from({ length: TIE_SIZE }, (_, k) => tieId(k)).sort();
    expect(ids).toEqual(want);
  }, WALK_TIMEOUT_MS);

  test("STRADDLE, query_contains with limit 1: still every tied row exactly once", async () => {
    const { ids } = await walk(STRADDLE, { query_contains: "needle-substring", limit: 1 });
    expect(ids).toEqual(Array.from({ length: TIE_SIZE }, (_, k) => tieId(k)).sort());
  }, WALK_TIMEOUT_MS);

  test("STRADDLE, unfiltered: every row exactly once, in (created_at desc, id asc) order", async () => {
    const { ids } = await walk(STRADDLE, {});
    const newestFirst = Array.from({ length: NEWER }, (_, i) => newerId(NEWER - 1 - i));
    const tied = Array.from({ length: TIE_SIZE }, (_, k) => tieId(k)).sort();
    // + the fixture's own baseline trace, oldest of all.
    expect(ids.length).toBe(NEWER + TIE_SIZE + 1);
    expect(ids.slice(0, NEWER + TIE_SIZE)).toEqual([...newestFirst, ...tied]);
  }, WALK_TIMEOUT_MS);

  test("WIDE, unfiltered: a tie group bigger than the window is paged completely, in id order", async () => {
    const { ids } = await walk(WIDE, {});
    const want = Array.from({ length: WIDE_SIZE }, (_, i) => wideId(i)).sort();
    expect(ids.length).toBe(WIDE_SIZE + 1);
    expect(ids.slice(0, WIDE_SIZE)).toEqual(want);
  }, WALK_TIMEOUT_MS);

  test("WIDE, query_contains: sparse matches inside one oversized tie group are all found", async () => {
    const { ids, pages } = await walk(WIDE, { query_contains: "needle-substring", limit: 10 });
    const want = Array.from({ length: WIDE_SIZE }, (_, i) => i).filter((i) => i % 100 === 7).map(wideId).sort();
    expect(ids).toEqual(want);
    // Only the page that proved the predicate exhausted may claim "full".
    expect(pages.at(-1)!.coverage).toBe("full");
  }, WALK_TIMEOUT_MS);
});
