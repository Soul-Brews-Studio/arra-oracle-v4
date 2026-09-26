// K5 fix round (docs/overnight/V3-PARITY.md §5; overnight R18): the keyset
// cursor must page past `MAX_SCANNED_TRACES` (1000), not dead-end there.
// Written BEFORE the fix -- RED on `service.listTraces.ts` at slice HEAD
// (61dd298): `after_created_at`/`after_id` were parsed but never pushed into
// the SQL predicate, so every page re-scanned the same newest 1000 rows
// regardless of the cursor; once a caller had paged past those 1000, the
// window held nothing "past the cursor" and `next_after_id`/
// `next_after_created_at` came back null while `has_more` stayed true --
// a dead end, and (via `oracle_trace_list`'s walk) a duplicate-producing one.
//
// 2005 rows, deliberately more than 2x MAX_SCANNED_TRACES: reaching the
// third `query_contains` match requires the cursor to cross the 1000-row
// boundary TWICE. Planted directly via the harness (`insertRawTraces`, one
// Arrow batch) rather than 2005 real `createTrace` calls, which would make
// the fixture itself the slow part of this test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openEvidenceReader } from "../src/publication/service";
import { createFixture, runGated, type Fixture } from "./helpers/publication-fixture";
import { traceId } from "./helpers/trace-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const WS = "ws-cursor-scale";
const CHILD = new URL("./fixtures/trace-v1/core/gated-trace.ts", import.meta.url).pathname;
const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const TOTAL = 2005;
const NEEDLE_INDEXES = [0, 1000, TOTAL - 1]; // spans three widened scan windows

// Fixed-width index BEFORE padding: `traceId`/`pad` fills the remainder with
// trailing zeros, so two seeds differing only by a numeral suffix of
// different length collide once padded ("bulk1" and "bulk10" both become
// "bulk1" + zeros). A zero-padded index keeps every seed the same length, so
// the padding adds the same fixed suffix and never erases the distinguishing
// digits.
const idFor = (i: number) => traceId(`bulk${i.toString().padStart(4, "0")}`);

// Explicit, sized from measurement (fix round 2): the 21-page unfiltered walk
// took 2.05 s at load average ~6 when every row cost three reads of its own,
// and hit bun's 5 s default 4/4 times at load 14-18 (verifier). With the
// page's rows read in one `IN (...)` batch it takes ~0.09 s at load ~6. 30 s
// is two orders of magnitude of headroom over that, and still fails fast
// on a real hang.
const WALK_TIMEOUT_MS = testTimeout(30_000);

type Row = { id: string; created_at: string; derived_from_count: number };
type ListTracesReader = {
  listTraces(b: Uint8Array): Promise<{
    rows: Row[];
    next_after_created_at: string | null;
    next_after_id: string | null;
    has_more: boolean;
    coverage: "full" | "partial";
  }>;
};

let fixture: Fixture;
let reader: Awaited<ReturnType<typeof openEvidenceReader>>;
const context = () => reader.context as unknown as ListTracesReader;

const req = (overrides: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      workspace_name: WS, parent_id: null, prev_id: null, depth: null, query_contains: null,
      after_created_at: null, after_id: null, limit: 100, ...overrides,
    }),
  );

beforeAll(async () => {
  fixture = await createFixture([WS]);
  const rows = Array.from({ length: TOTAL }, (_, i) => ({
    id: idFor(i),
    workspace_name: WS,
    query: NEEDLE_INDEXES.includes(i) ? `has the needle-substring at index ${i}` : `plain trace row ${i}`,
    depth: "0",
    status: "open",
    created_at_millis: (BASE + i).toString(10),
    updated_at_millis: (BASE + i).toString(10),
  }));
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

describe("K5 kernel: the keyset cursor crosses the MAX_SCANNED_TRACES boundary", () => {
  test("an unfiltered walk visits every planted row exactly once and terminates", async () => {
    const seen = new Set<string>();
    let after_created_at: string | null = null;
    let after_id: string | null = null;
    let pages = 0;
    for (; pages < 30; pages++) {
      const result = await context().listTraces(req({ after_created_at, after_id }));
      for (const row of result.rows) {
        // A dead end would come back as an empty page while `has_more` stays
        // true forever -- catch a repeat immediately rather than let the
        // loop's own 30-page cap silently swallow it as "did not finish".
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!result.has_more) break;
      // The exact dead end this fix removes: `has_more:true` with nothing to
      // resume from would otherwise send the NEXT call back to cursor null,
      // repeating this same page forever.
      expect(result.next_after_created_at !== null && result.next_after_id !== null).toBe(true);
      after_created_at = result.next_after_created_at;
      after_id = result.next_after_id;
    }
    expect(pages).toBeLessThan(30);
    // `createFixture` seeds one baseline trace per workspace too (oldest of
    // all, per `trace-list-service.test.ts`'s own comment) -- TOTAL planted
    // plus that one.
    expect(seen.size).toBe(TOTAL + 1);
  }, WALK_TIMEOUT_MS);

  test("query_contains reaches a match past TWO 1000-row windows, never a dead end short of it", async () => {
    const wantIds = NEEDLE_INDEXES.map(idFor);
    const found: string[] = [];
    let after_created_at: string | null = null;
    let after_id: string | null = null;
    for (let pages = 0; pages < 30 && found.length < wantIds.length; pages++) {
      const result = await context().listTraces(
        req({ query_contains: "needle-substring", limit: 10, after_created_at, after_id }),
      );
      for (const row of result.rows) found.push(row.id);
      if (!result.has_more) break;
      expect(result.next_after_created_at !== null && result.next_after_id !== null).toBe(true);
      after_created_at = result.next_after_created_at;
      after_id = result.next_after_id;
    }
    // Newest first: index TOTAL-1, then 1000, then 0.
    expect(found).toEqual([idFor(TOTAL - 1), idFor(1000), idFor(0)]);
  }, WALK_TIMEOUT_MS);
});
