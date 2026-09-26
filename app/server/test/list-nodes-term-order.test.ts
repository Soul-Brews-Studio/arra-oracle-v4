/**
 * #88/#29/K3/K4 `listNodes`: the term filter (`all_term_ids`/`any_term_ids`)
 * and the `updated_desc` order (overnight R18, docs/overnight/V3-PARITY.md
 * §5/§7), split out of `list-nodes-service.test.ts` to stay under this repo's
 * 500-line-per-file cap (the same reason earlier splits like
 * `test/lifecycle-eligibility-ac1.test.ts` exist).
 *
 * Same setup convention as `list-nodes-service.test.ts`: a real seeded
 * target19 dataset from the Python exporter, writes run inside the real
 * writer gate via an exec'd child, reads go straight through
 * `openPublicationReader`. This file owns BETA exclusively -- nothing else
 * publishes into it -- so its node-id/order assertions need no isolating
 * filter of their own beyond what each test already applies.
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
import { LIST_NODES_ORDERS } from "../src/publication/service.parseListNodes";

const CHILD = new URL("./fixtures/publication-v1/gated-publish.ts", import.meta.url).pathname;
const BETA = "beta-workspace";
/** A fixed instant; nothing here reads a real clock. */
const CLOCK_MS = Date.parse("2026-09-20T12:00:00.000Z");

let fixture: Fixture;
let beta: SeededWorkspace;

const nodeId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const revId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

/** For a grammar-error assertion: resolves to the thrown `PublicationError`
 *  (any shape), never throws itself -- the caller checks `.code`/`.path`. */
async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to be refused, but it succeeded");
}

type ListNodesPage = {
  rows: Record<string, unknown>[];
  next_after_id: string | null;
  next_after_updated_at: string | null;
  total: string | null;
};

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
  all_term_ids?: string[] | null;
  any_term_ids?: string[] | null;
  order?: "id_asc" | "updated_desc";
  after_updated_at?: string | null;
}): Promise<ListNodesPage> {
  const reader = await openPublicationReader(fixture.datasetRoot);
  return (await reader.listNodes(encodeRequest(request))) as ListNodesPage;
}

beforeAll(async () => {
  fixture = await createFixture([BETA]);
  beta = fixture.workspaces[BETA]!;
}, 180_000);

afterAll(async () => {
  await fixture?.cleanup();
});

// K3 (overnight R18, docs/overnight/V3-PARITY.md §5/§7): `all_term_ids` /
// `any_term_ids`.
describe("listNodes: all_term_ids / any_term_ids filter (K3)", () => {
  const snapshotOf = (...terms: { id: string; vocabulary_id: string; vocabulary_name: string; name: string }[]) =>
    JSON.stringify(
      terms.map((term, position) => ({
        term_id: term.id,
        vocabulary_id: term.vocabulary_id,
        vocabulary_name_snapshot: term.vocabulary_name,
        term_name_snapshot: term.name,
        label_snapshot: null,
        position: String(position),
      })),
    );

  const k3Note = nodeId("k3filternoteonly");
  const k3NoteStorage = nodeId("k3filternotestora");
  const k3NoteHorizon = nodeId("k3filternotehrzn");
  const k3NoteStorageHorizon = nodeId("k3filterbothterm");
  const k3Decision = nodeId("k3filterdecstora");

  beforeAll(async () => {
    const noteType = beta.term_ids.type.note;
    const decisionType = beta.term_ids.type.decision;
    const horizon = beta.term_ids.memory_horizon.short_term;
    const storage = beta.term_ids.topic.storage;

    const publishes: [string, Record<string, unknown>][] = [
      [k3Note, revisionEnvelope(BETA, beta, k3Note, { title: "note only" })],
      [
        k3NoteStorage,
        revisionEnvelope(BETA, beta, k3NoteStorage, { title: "note+storage", term_snapshot_json: snapshotOf(noteType, storage) }),
      ],
      [
        k3NoteHorizon,
        revisionEnvelope(BETA, beta, k3NoteHorizon, { title: "note+horizon", term_snapshot_json: snapshotOf(noteType, horizon) }),
      ],
      [
        k3NoteStorageHorizon,
        revisionEnvelope(BETA, beta, k3NoteStorageHorizon, {
          title: "note+storage+horizon",
          term_snapshot_json: snapshotOf(noteType, storage, horizon),
        }),
      ],
      [
        k3Decision,
        revisionEnvelope(BETA, beta, k3Decision, { title: "decision+storage", term_snapshot_json: snapshotOf(decisionType, storage) }),
      ],
    ];
    for (const [i, [node, content]] of publishes.entries()) {
      const result = await publish({ operation_id: `op-k3-filter-${i}`, content }, [revId(`k3filterrev${i}`)]);
      expect(result.ok).toBe(true);
    }
  }, 180_000);

  test("any_term_ids: at least one of the listed ids must be assigned", async () => {
    const storage = beta.term_ids.topic.storage;
    const page = await listNodes({
      workspace_name: BETA, after_id: null, limit: 100, include_total: false, include_inactive: false,
      type_term: null, any_term_ids: [storage.id],
    });
    const ids = page.rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([k3NoteStorage, k3NoteStorageHorizon, k3Decision]));
    expect(ids).not.toContain(k3Note);
    expect(ids).not.toContain(k3NoteHorizon);
  });

  test("any_term_ids with two ids matches a node carrying EITHER", async () => {
    const storage = beta.term_ids.topic.storage;
    const horizon = beta.term_ids.memory_horizon.short_term;
    const page = await listNodes({
      workspace_name: BETA, after_id: null, limit: 100, include_total: false, include_inactive: false,
      type_term: null, any_term_ids: [storage.id, horizon.id],
    });
    const ids = page.rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([k3NoteStorage, k3NoteHorizon, k3NoteStorageHorizon, k3Decision]));
    expect(ids).not.toContain(k3Note);
  });

  test("all_term_ids requires EVERY listed id to be assigned -- only the node with both", async () => {
    const storage = beta.term_ids.topic.storage;
    const horizon = beta.term_ids.memory_horizon.short_term;
    const page = await listNodes({
      workspace_name: BETA, after_id: null, limit: 100, include_total: false, include_inactive: false,
      type_term: null, all_term_ids: [storage.id, horizon.id],
    });
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(k3NoteStorageHorizon);
    expect(ids).not.toContain(k3NoteStorage);
    expect(ids).not.toContain(k3NoteHorizon);
    expect(ids).not.toContain(k3Note);
    expect(ids).not.toContain(k3Decision);
  });

  test("all_term_ids combined with type_term is an AND: a term match of the wrong type is excluded", async () => {
    const storage = beta.term_ids.topic.storage;
    const page = await listNodes({
      workspace_name: BETA, after_id: null, limit: 100, include_total: false, include_inactive: false,
      type_term: "note", any_term_ids: [storage.id],
    });
    const ids = page.rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([k3NoteStorage, k3NoteStorageHorizon]));
    // k3Decision carries the SAME storage term but the wrong type -- proves
    // this is a real AND, not `any_term_ids` alone re-implementing the whole
    // filter.
    expect(ids).not.toContain(k3Decision);
  });

  test("include_total stays null with a term-id filter set -- no native scoped count for a JSON-embedded field", async () => {
    const storage = beta.term_ids.topic.storage;
    const page = await listNodes({
      workspace_name: BETA, after_id: null, limit: 100, include_total: true, include_inactive: false,
      type_term: null, any_term_ids: [storage.id],
    });
    expect(page.total).toBeNull();
  });

  test("grammar: an empty array is refused, not treated as 'no filter'", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({ workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null, any_term_ids: [] })));
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/any_term_ids");
  });

  test("grammar: an explicit null is refused once the key is present -- omit the key for 'no filter'", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({ workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null, all_term_ids: null })));
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/all_term_ids");
  });

  test("grammar: a duplicate id in the array is refused", async () => {
    const storage = beta.term_ids.topic.storage;
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({ workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null, any_term_ids: [storage.id, storage.id] })));
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/any_term_ids");
  });

  test("grammar: a non-nanoid21 entry is refused", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({ workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null, any_term_ids: ["not-a-nanoid21"] })));
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/any_term_ids");
  });

  test("grammar: more than MAX_FILTER_TERM_IDS (20) entries is limit_exceeded", async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => nodeId(`k3toomanyterm${i}`));
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({ workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null, all_term_ids: tooMany })));
    expect(caught?.code).toBe("limit_exceeded");
    expect(caught?.path).toBe("/all_term_ids");
  });
});

// K4 (overnight R18): `order: "updated_desc"`, paired with `after_updated_at`.
describe("listNodes: order (K4)", () => {
  test("grammar: an unknown order value is invalid_request", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({ workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null, order: "bogus" })));
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/order");
  });

  // `LIST_NODES_ORDERS` is the closed set `parseListNodes` validates `order`
  // against -- since the R18 D3 fix round literally (`.includes`), not by a
  // second hardcoded pair of literals, which made this test a tautology (a
  // verifier finding). Pinning it here means a change to the set is caught
  // at the SAME place this file already asserts each value's behaviour.
  test("LIST_NODES_ORDERS is exactly the two orders this grammar accepts", () => {
    expect(LIST_NODES_ORDERS).toEqual(["id_asc", "updated_desc"]);
  });

  test("grammar: after_updated_at is refused under the default (id_asc) order", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({
        workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null,
        after_updated_at: "2026-09-20T12:00:00.000Z",
      })));
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/after_updated_at");
  });

  test("grammar: under updated_desc, after_id and after_updated_at are a pair -- one set without the other is invalid_request", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const nodeSetOnly = await captureError(reader.listNodes(encodeRequest({
        workspace_name: BETA, after_id: nodeId("somerealisticid"), limit: 10, include_total: false, type_term: null, order: "updated_desc",
      })));
    expect(nodeSetOnly?.code).toBe("invalid_request");
    expect(nodeSetOnly?.path).toBe("/after_updated_at");

    const updatedSetOnly = await captureError(reader.listNodes(encodeRequest({
        workspace_name: BETA, after_id: null, limit: 10, include_total: false, type_term: null, order: "updated_desc",
        after_updated_at: "2026-09-20T12:00:00.000Z",
      })));
    expect(updatedSetOnly?.code).toBe("invalid_request");
    expect(updatedSetOnly?.path).toBe("/after_updated_at");
  });

  test("grammar: a malformed after_updated_at is invalid_request", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const caught = await captureError(reader.listNodes(encodeRequest({
        workspace_name: BETA, after_id: nodeId("somerealisticid"), limit: 10, include_total: false, type_term: null, order: "updated_desc",
        after_updated_at: "not-a-timestamp",
      })));
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/after_updated_at");
  });

  test("next_after_updated_at is always null under the default id_asc order", async () => {
    const page = await listNodes({ workspace_name: BETA, after_id: null, limit: 1, include_total: false, include_inactive: false, type_term: null });
    expect(page.next_after_updated_at).toBeNull();
  });

  // A combo none of the K3 tests above used (decision+storage+horizon), so a
  // type_term + all_term_ids filter isolates exactly this block's own nodes
  // from BETA's other accumulated rows with no separate workspace needed.
  describe("ordering and pagination", () => {
    const decisionType = () => beta.term_ids.type.decision;
    const storage = () => beta.term_ids.topic.storage;
    const horizon = () => beta.term_ids.memory_horizon.short_term;
    const snapshotOf = (...terms: { id: string; vocabulary_id: string; vocabulary_name: string; name: string }[]) =>
      JSON.stringify(
        terms.map((term, position) => ({
          term_id: term.id,
          vocabulary_id: term.vocabulary_id,
          vocabulary_name_snapshot: term.vocabulary_name,
          term_name_snapshot: term.name,
          label_snapshot: null,
          position: String(position),
        })),
      );

    const k4Newest = nodeId("k4orderznewest");
    const k4Mid = nodeId("k4ordermid");
    const k4TieA = nodeId("k4ordertieaaaaaa");
    const k4TieB = nodeId("k4ordertiebbbbbb");
    const k4Oldest = nodeId("k4orderoldest");

    beforeAll(async () => {
      const content = (node: string, title: string) =>
        revisionEnvelope(BETA, beta, node, { title, term_snapshot_json: snapshotOf(decisionType(), storage(), horizon()) });
      const plan: [string, number][] = [
        [k4Newest, CLOCK_MS + 5000],
        [k4Mid, CLOCK_MS + 4000],
        [k4TieA, CLOCK_MS + 3000],
        [k4TieB, CLOCK_MS + 3000],
        [k4Oldest, CLOCK_MS + 2000],
      ];
      for (const [i, [node, clockMs]] of plan.entries()) {
        const result = await publish(
          { operation_id: `op-k4-order-${i}`, content: content(node, `k4-${i}`) },
          [revId(`k4orderrev${i}`)],
          { clockMs },
        );
        expect(result.ok).toBe(true);
      }
    }, 180_000);

    const isolatingFilter = () => ({ type_term: "decision" as const, all_term_ids: [storage().id, horizon().id] });

    test("orders newest-updated first, and breaks an exact tie by id ascending", async () => {
      const page = await listNodes({
        workspace_name: BETA, after_id: null, limit: 100, include_total: false, include_inactive: false,
        order: "updated_desc", ...isolatingFilter(),
      });
      const ids = page.rows.map((r) => r.id);
      expect(ids).toEqual([k4Newest, k4Mid, k4TieA, k4TieB, k4Oldest]);
    });

    test("the updated_desc keyset pair walks every row exactly once, in the same order, across limit:1 pages", async () => {
      const seen: string[] = [];
      let afterId: string | null = null;
      let afterUpdatedAt: string | null = null;
      let guard = 0;
      for (;;) {
        guard += 1;
        if (guard > 20) throw new Error("pagination did not converge");
        const page = await listNodes({
          workspace_name: BETA, after_id: afterId, limit: 1, include_total: false, include_inactive: false,
          order: "updated_desc", after_updated_at: afterUpdatedAt, ...isolatingFilter(),
        });
        if (page.rows.length === 0) break;
        seen.push(...page.rows.map((r) => r.id as string));
        if (page.next_after_id === null) break;
        afterId = page.next_after_id;
        afterUpdatedAt = page.next_after_updated_at;
        expect(typeof afterUpdatedAt).toBe("string");
      }
      expect(seen).toEqual([k4Newest, k4Mid, k4TieA, k4TieB, k4Oldest]);
      expect(new Set(seen).size).toBe(seen.length);
    }, 180_000);

    test("next_after_updated_at is null once the walk is exhausted", async () => {
      const page = await listNodes({
        workspace_name: BETA, after_id: null, limit: 100, include_total: false, include_inactive: false,
        order: "updated_desc", ...isolatingFilter(),
      });
      expect(page.next_after_id).toBeNull();
      expect(page.next_after_updated_at).toBeNull();
    });
  });
});
