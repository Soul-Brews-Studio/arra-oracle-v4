/**
 * #88 `listNodes`: real persistence against a seeded target19 copy.
 *
 * Same setup convention as `publication-service.test.ts` -- every dataset
 * here is created by the Python exporter into a scratch directory this file
 * owns and removes, and writers run inside the real writer gate via an
 * exec'd child. `listNodes` itself is a pure read, so most assertions below
 * go straight through `openPublicationReader` with no gate involved.
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
import { openPublicationReader } from "../src/publication/service";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/publication-v1/gated-publish.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
/** A fixed instant; nothing here reads a real clock. */
const CLOCK_MS = Date.parse("2026-09-20T12:00:00.000Z");

let fixture: Fixture;
let alpha: SeededWorkspace;
let beta: SeededWorkspace;

const nodeId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const revId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

type ListNodesPage = { rows: Record<string, unknown>[]; next_after_id: string | null; total: string | null };

async function publish(
  request: unknown,
  revisionIds: string[],
  options: { clockMs?: number } = {},
): Promise<{ ok: boolean; outcome?: Record<string, unknown>; code?: string | null }> {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ request, revisionIds, clockMs: options.clockMs ?? CLOCK_MS }),
  ]);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 400)}`);
  return JSON.parse(line);
}

async function listNodes(request: {
  workspace_name: string;
  after_id: string | null;
  limit: number;
  include_total: boolean;
  include_inactive: boolean;
  type_term: string | null;
}): Promise<ListNodesPage> {
  const reader = await openPublicationReader(fixture.datasetRoot);
  return (await reader.listNodes(encodeRequest(request))) as ListNodesPage;
}

beforeAll(async () => {
  fixture = await createFixture([ALPHA, BETA]);
  alpha = fixture.workspaces[ALPHA]!;
  beta = fixture.workspaces[BETA]!;
}, testTimeout(180_000));

afterAll(async () => {
  await fixture?.cleanup();
});

describe("listNodes: base cases", () => {
  test("an empty workspace returns an empty page with next_after_id and total both null", async () => {
    const page = await listNodes({ workspace_name: BETA, after_id: null, limit: 10, include_total: false, include_inactive: false, type_term: null });
    expect(page.rows).toEqual([]);
    expect(page.next_after_id).toBeNull();
    expect(page.total).toBeNull();
  });

  test("a published node's head title, revision_no and content_digest join correctly", async () => {
    const node = nodeId("listnodesjoinA");
    const revision = revId("listnodesjoinrA");
    const result = await publish(
      { operation_id: "op-listnodes-join", content: revisionEnvelope(ALPHA, alpha, node, { title: "Joined Title" }) },
      [revision],
    );
    expect(result.ok).toBe(true);

    // Walk pages (bounded by MAX_PAGE_LIMIT) until the node turns up or the
    // workspace is exhausted -- ALPHA accumulates nodes across tests in this
    // file, so there is no single page guaranteed to contain it.
    let row: Record<string, unknown> | undefined;
    let after: string | null = null;
    for (let guard = 0; guard < 1000 && row === undefined; guard += 1) {
      const page = await listNodes({ workspace_name: ALPHA, after_id: after, limit: 100, include_total: false, include_inactive: false, type_term: null });
      row = page.rows.find((r) => r.id === node);
      if (page.next_after_id === null) break;
      after = page.next_after_id;
    }
    expect(row).toBeDefined();
    expect(row!.title).toBe("Joined Title");
    expect(row!.revision_no).toBe("1");
    expect(row!.content_digest).toBe(result.outcome!.content_digest);
    expect(row!.current_revision_id).toBe(revision);
  }, testTimeout(180_000));
});

describe("listNodes: include_inactive is OPTIONAL (#29 fix round: unblocks the `nodes list` CLI alias)", () => {
  test("a request with no `include_inactive` key at all parses fine, defaulting to false -- the exact wire shape `app/cli/kb.aliases.ts`'s `nodes list` alias sends without --history", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const page = (await reader.listNodes(
      encodeRequest({ workspace_name: BETA, after_id: null, limit: 10, include_total: true, type_term: null }),
    )) as ListNodesPage;
    // BETA only ever receives active nodes in this file; a defaulted-false
    // request must behave identically to an explicit `include_inactive: false`
    // one -- same empty-workspace shape as the very first test above.
    expect(page.rows).toEqual([]);
    expect(page.total).toBe("0");
  });

  test("an explicit `include_inactive: null` is still refused invalid_request -- closed-typed (boolean only), not merely optional", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    let caught: any = null;
    try {
      await reader.listNodes(
        encodeRequest({
          workspace_name: BETA,
          after_id: null,
          limit: 10,
          include_total: false,
          type_term: null,
          include_inactive: null,
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/include_inactive");
  });
});

describe("listNodes: keyset pagination", () => {
  test("limit-1 pagination returns a real next_after_id, and the following page exhausts it to null", async () => {
    const n1 = nodeId("limit1pageA");
    const n2 = nodeId("limit1pageB");
    const r1 = await publish({ operation_id: "op-limit1-a", content: revisionEnvelope(ALPHA, alpha, n1) }, [
      revId("limit1revA"),
    ]);
    const r2 = await publish({ operation_id: "op-limit1-b", content: revisionEnvelope(ALPHA, alpha, n2) }, [
      revId("limit1revB"),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const page1 = await listNodes({ workspace_name: ALPHA, after_id: null, limit: 1, include_total: false, include_inactive: false, type_term: null });
    expect(page1.rows.length).toBe(1);
    expect(page1.next_after_id).not.toBeNull();
    expect(typeof page1.next_after_id).toBe("string");

    // Walk until BOTH seeded ids have been seen, proving next_after_id
    // genuinely advances rather than repeating the same page.
    const seenIds = new Set(page1.rows.map((r) => r.id as string));
    let after = page1.next_after_id;
    let guard = 0;
    while (!(seenIds.has(n1) && seenIds.has(n2)) && guard < 1000) {
      guard += 1;
      const page = await listNodes({ workspace_name: ALPHA, after_id: after, limit: 1, include_total: false, include_inactive: false, type_term: null });
      expect(page.rows.length).toBeGreaterThan(0);
      for (const row of page.rows) seenIds.add(row.id as string);
      after = page.next_after_id;
      if (after === null) break;
    }
    expect(seenIds.has(n1)).toBe(true);
    expect(seenIds.has(n2)).toBe(true);

    // Eventually the cursor exhausts to null -- not "some later page is
    // short", the terminal page itself reports no continuation.
    let finalNextAfterId: string | null = after;
    while (finalNextAfterId !== null && guard < 2000) {
      guard += 1;
      const page = await listNodes({
        workspace_name: ALPHA,
        after_id: finalNextAfterId,
        limit: 100,
        include_total: false,
        include_inactive: false, type_term: null,
      });
      finalNextAfterId = page.next_after_id;
    }
    expect(finalNextAfterId).toBeNull();
  }, testTimeout(180_000));

  test("a full keyset walk visits every id exactly once, strictly increasing, with no short-but-continuing page", async () => {
    const seeds = ["walk1", "walk2", "walk3", "walk4", "walk5"].map((s) => nodeId(`listnodes${s}`));
    for (const [i, node] of seeds.entries()) {
      const result = await publish(
        { operation_id: `op-listnodes-walk-${i}`, content: revisionEnvelope(ALPHA, alpha, node) },
        [revId(`listnodeswalkr${i}`)],
      );
      expect(result.ok).toBe(true);
    }

    const seen: string[] = [];
    let after: string | null = null;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 10_000) throw new Error("pagination did not converge");
      const page = await listNodes({ workspace_name: ALPHA, after_id: after, limit: 2, include_total: false, include_inactive: false, type_term: null });
      // Every page except possibly the last is exactly `limit` long; a short
      // page that still claims `next_after_id` would be a gap, not a page.
      if (page.next_after_id !== null) expect(page.rows.length).toBe(2);
      for (const row of page.rows) {
        const id = row.id as string;
        // Strictly increasing across the ENTIRE walk: no duplicate and no
        // out-of-order id, across a page boundary as much as within one.
        if (seen.length > 0) expect(id > seen[seen.length - 1]!).toBe(true);
        seen.push(id);
      }
      if (page.next_after_id === null) break;
      after = page.next_after_id;
    }

    for (const node of seeds) {
      expect(seen.filter((id) => id === node)).toHaveLength(1);
    }
    expect(new Set(seen).size).toBe(seen.length);

    // Exhaustion is a real boundary, not just "the last call returned some
    // rows anyway": one more call from the final cursor is an empty page.
    const last = seen[seen.length - 1]!;
    const afterEnd = await listNodes({ workspace_name: ALPHA, after_id: last, limit: 10, include_total: false, include_inactive: false, type_term: null });
    expect(afterEnd.rows).toEqual([]);
    expect(afterEnd.next_after_id).toBeNull();
  }, testTimeout(180_000));
});

describe("listNodes: include_total", () => {
  test("include_total: false always returns total: null", async () => {
    const page = await listNodes({ workspace_name: ALPHA, after_id: null, limit: 10, include_total: false, include_inactive: false, type_term: null });
    expect(page.total).toBeNull();
  });

  test("include_total: true, unfiltered, returns the native workspace-scoped count as a decimal string", async () => {
    await publish(
      { operation_id: "op-total-workspace", content: revisionEnvelope(ALPHA, alpha, nodeId("totalworkspaceA")) },
      [revId("totalworkspacerA")],
    );

    const before = await listNodes({ workspace_name: ALPHA, after_id: null, limit: 1, include_total: true, include_inactive: false, type_term: null });
    // Compare against an independent full walk's count rather than a
    // hardcoded literal, since ALPHA accumulates nodes across this file's
    // other tests and test order is not something this test should pin.
    let walked = 0;
    let after: string | null = null;
    for (let guard = 0; guard < 1000; guard += 1) {
      const page = await listNodes({ workspace_name: ALPHA, after_id: after, limit: 100, include_total: false, include_inactive: false, type_term: null });
      walked += page.rows.length;
      if (page.next_after_id === null) break;
      after = page.next_after_id;
    }
    expect(typeof before.total).toBe("string");
    expect(before.total).toBe(String(walked));
    // Canonical decimal text: no leading zeros, no plus sign.
    expect(before.total).toMatch(/^(?:0|[1-9][0-9]*)$/);
  }, testTimeout(180_000));

  test("include_total: true with type_term set leaves total null -- no native scoped count for a JSON-embedded field", async () => {
    const decisionType = alpha.term_ids.type.decision;
    const page = await listNodes({
      workspace_name: ALPHA,
      after_id: null,
      limit: 10,
      include_total: true,
      include_inactive: false, type_term: decisionType.name,
    });
    expect(page.total).toBeNull();
  });
});

describe("listNodes: type_term filter", () => {
  test("returns only nodes whose CURRENT revision carries the requested type, and an unmatched type is an empty page", async () => {
    const noteType = alpha.term_ids.type.note;
    const decisionType = alpha.term_ids.type.decision;

    const noteNode = nodeId("typetermnoteA");
    const decisionNode = nodeId("typetermdecA");

    const noteEnvelope = revisionEnvelope(ALPHA, alpha, noteNode, { title: "A Note" });
    const decisionEnvelope = revisionEnvelope(ALPHA, alpha, decisionNode, {
      title: "A Decision",
      term_snapshot_json: JSON.stringify([
        {
          term_id: decisionType.id,
          vocabulary_id: decisionType.vocabulary_id,
          vocabulary_name_snapshot: decisionType.vocabulary_name,
          term_name_snapshot: decisionType.name,
          label_snapshot: null,
          position: "0",
        },
      ]),
    });

    const rNote = await publish({ operation_id: "op-typeterm-note", content: noteEnvelope }, [
      revId("typetermnoterevA"),
    ]);
    const rDecision = await publish({ operation_id: "op-typeterm-decision", content: decisionEnvelope }, [
      revId("typetermdecrevA"),
    ]);
    expect(rNote.ok).toBe(true);
    expect(rDecision.ok).toBe(true);

    // Filtered: only the decision-typed node comes back, regardless of what
    // else ALPHA accumulated across this file's other tests.
    const decisions = await listNodes({
      workspace_name: ALPHA,
      after_id: null,
      limit: 100,
      include_total: false,
      include_inactive: false, type_term: decisionType.name,
    });
    const decisionIds = decisions.rows.map((r) => r.id);
    expect(decisionIds).toContain(decisionNode);
    expect(decisionIds).not.toContain(noteNode);
    const decisionRow = decisions.rows.find((r) => r.id === decisionNode)!;
    expect(decisionRow.title).toBe("A Decision");

    // Every OTHER row on this filtered page is also decision-typed, not just
    // the one this test published -- a wrong filter that let notes through
    // would still pass an "expect toContain" check alone.
    const reader = await openPublicationReader(fixture.datasetRoot);
    for (const row of decisions.rows) {
      const history = (await reader.getAcceptedHead(
        encodeRequest({ workspace_name: ALPHA, node_id: row.id }),
      )) as { revision: Record<string, unknown> };
      const snapshot = JSON.parse(history.revision.term_snapshot_json as string) as Record<string, unknown>[];
      const typeEntry = snapshot.find((e) => e.vocabulary_name_snapshot === "type");
      expect(typeEntry?.term_name_snapshot).toBe(decisionType.name);
    }

    // An unmatched type_term (note's own node published under a type_term
    // filter for note) still returns real matches, never an error --
    // exercised here as "filtering by note returns the note node and
    // excludes the decision node", the mirror image of the check above.
    const notes = await listNodes({
      workspace_name: ALPHA,
      after_id: null,
      limit: 100,
      include_total: false,
      include_inactive: false, type_term: noteType.name,
    });
    const noteIds = notes.rows.map((r) => r.id);
    expect(noteIds).toContain(noteNode);
    expect(noteIds).not.toContain(decisionNode);

    // A type_term that matches nothing at all in this workspace: an empty
    // page, not a thrown error.
    const none = await listNodes({
      workspace_name: ALPHA,
      after_id: null,
      limit: 10,
      include_total: false,
      include_inactive: false, type_term: "no-such-type-term-anywhere",
    });
    expect(none.rows).toEqual([]);
    expect(none.next_after_id).toBeNull();
  }, testTimeout(180_000));
});
