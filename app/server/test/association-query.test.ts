/**
 * #68 association query evidence (association-evidence-v1 §7, fixtures/query lane).
 *
 * Scope: reverse completeness over two traces and two sessions across multiple
 * nodes; capture-digest identity versus display-only annotation; repeated citing
 * positions retained as separate occurrences; current versus history semantics;
 * absent, divergent, duplicate and extra physical projections being unable to
 * change an authoritative answer; raw orphan invisibility; a full resumable scan
 * from a null cursor through unchanged returned cursors including empty
 * non-terminal pages; cursor scope binding; and nodes-version restart
 * invalidating an accumulated scan.
 *
 * ABSENT API IS NOT GREEN EVIDENCE. At base f9e5abe8 `openEvidenceReader` and
 * `openEvidenceWriter` do not exist. Every test calls `requireEvidenceApi()`
 * FIRST — before any fixture is built or child spawned — so the suite fails with
 * a legible reason rather than skipping (green from nothing) or burning a minute
 * of process work to reach an undefined call.
 *
 * INDEPENDENT ORACLES. Expected occurrence sets are built here as sorted
 * `(node_id, revision_id, position)` tuples from the seeds this file authored,
 * and compared by set equality — not by asking the implementation what it found.
 * Where target keys matter the assertions are RELATIONAL: two capture digests
 * must yield disjoint results, a display-only change must yield identical
 * results. Those relations follow from §5's identity rule and are checkable
 * without re-deriving SHA-256 or JCS here, which would only reimplement the
 * codec badly. The accepted codec is used for fixture PREPARATION.
 *
 * BOUNDED CLAIMS. Seeding writes orphan revisions and deliberately wrong derived
 * rows that no service path would produce, so the dataset is disposable fixture
 * state. Nothing here asserts a citation is true, a capture was fetched, a source
 * row still exists, or that any caller was authorized: §1 says workspace
 * predicates are isolation checks, not authentication, and §3 says capture
 * annotations are retained claims, not live access checks.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetOp } from "../src/contracts/evidence-v1";
import { revisionOp } from "../src/contracts/revision-v1";
import * as service from "../src/publication/service";
import { runGated } from "./helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/association-v1/query/seed-child.ts", import.meta.url).pathname;
const SEED_DEADLINE_MS = scaledMs(300_000);
const TEST_TIMEOUT_MS = testTimeout(600_000);

const W1 = "alpha-workspace";
const W2 = "beta-workspace";

const MICROS_PER_MS = 1000n;
const SEED_MS = 1789948800000n; // 2026-09-21T00:00:00.000Z
const SEED_MICROS = SEED_MS * MICROS_PER_MS;
const SEED_ISO = new Date(Number(SEED_MS)).toISOString();

/** §6 fixed literal for a cursor that does not match its request. */
const CURSOR_MISMATCH_MESSAGE = "evidence cursor does not match request";

/** The existing fixed publication message, restated rather than imported. */
const SAFE_INVALID_REFERENCE = "invalid scoped reference";

/** Physical wire field order, quoted from §3. */
const LINK_WIRE_ORDER = [
  "workspace_name", "revision_id", "position", "relation", "target_kind", "target",
  "target_key", "excerpt", "content_hash", "captured_at", "capture_status", "note",
] as const;
const TERM_WIRE_ORDER = [
  "workspace_name", "revision_id", "term_id", "vocabulary_id",
  "vocabulary_name_snapshot", "term_name_snapshot", "label_snapshot", "position",
] as const;

function requireEvidenceApi(): {
  openEvidenceReader: (root: string) => Promise<never>;
} {
  const api = service as unknown as Record<string, unknown>;
  const missing = ["openEvidenceReader", "openEvidenceWriter"].filter(
    (name) => typeof api[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `evidence API absent: ${missing.join(", ")} not exported from publication/service. ` +
        "Expected from #65; these association query tests are red by construction until it lands.",
    );
  }
  return api as never;
}

// ── identifiers and targets ─────────────────────────────────────────────────

function id21(prefix: string, n: number): string {
  const digits = String(n).padStart(6, "0");
  return `${prefix}${"_".repeat(Math.max(0, 21 - prefix.length - digits.length))}${digits}`.slice(0, 21);
}

const TRACE_1 = { kind: "trace", target: { trace_id: "trace-one" } } as const;
const TRACE_2 = { kind: "trace", target: { trace_id: "trace-two" } } as const;
const SESSION_1 = { kind: "session", target: { session_name: "session-one" } } as const;
const SESSION_2 = { kind: "session", target: { session_name: "session-two" } } as const;

/** Same Relic location, two capture digests — §5 puts the digest IN identity. */
const relicEvent = (digest: string) =>
  ({
    kind: "relic_event",
    target: {
      source_bank: "bank-a",
      provider: "claude",
      session_uuid: "uuid-one",
      transcript_ref: "transcript-a",
      event_seq: "7",
      capture_digest: digest,
    },
  }) as const;

/** Same identity, different display text — §5 excludes title_snapshot. */
const relicSession = (title: string | null) =>
  ({
    kind: "relic_session",
    target: {
      source_bank: "bank-a",
      provider: "claude",
      session_uuid: "uuid-two",
      title_snapshot: title,
    },
  }) as const;

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

type TargetSpec = { kind: string; target: Record<string, unknown> };

/**
 * Prepared by the accepted codec; the ASSERTIONS below stay relational.
 *
 * The target must be a Map, not a plain object: the governed codec takes a
 * `JcsObject`, and `requireClosedObject` rejects anything that is not a `Map`
 * with `invalid_type` at `/target`. Every accepted caller passes the Map the
 * strict parser produced; a literal written in a test has to be converted. The
 * target shapes in §5 are flat, so one level of `Object.entries` is exactly
 * the conversion needed and no nested value is affected.
 */
function prepared(workspace: string, spec: TargetSpec) {
  const target = new Map(Object.entries(spec.target));
  const result = targetOp(workspace as never, spec.kind as never, target as never, []);
  return { target_json: result.target_json, target_key: result.target_key };
}

// ── seeds ───────────────────────────────────────────────────────────────────

type LinkSeed = {
  position: number;
  relation?: string;
  spec: TargetSpec;
  excerpt?: string | null;
  /** Bytes of 'a' the child appends to this link's excerpt. */
  excerptPad?: number;
  capture_status?: string;
  note?: string | null;
};

type RevisionSeed = {
  workspace: string;
  nodeId: string;
  revisionId: string;
  revisionNo: number;
  baseRevisionId: string | null;
  links: LinkSeed[];
};

const TYPE_TERM = {
  term_id: id21("term", 1),
  vocabulary_id: id21("vocab", 1),
  vocabulary_name_snapshot: "type",
  term_name_snapshot: "note",
  label_snapshot: null,
  position: "0",
};

function linkEntry(seed: LinkSeed, workspace: string) {
  return {
    position: String(seed.position),
    relation: seed.relation ?? "supports",
    target_kind: seed.spec.kind,
    target: seed.spec.target,
    excerpt: seed.excerpt ?? null,
    content_hash: null,
    captured_at: null,
    capture_status: seed.capture_status ?? "locator_only",
    note: seed.note ?? null,
  };
}

/** The revision row the child will seed, with snapshots the codec normalizes. */
function revisionRow(seed: RevisionSeed): Record<string, unknown> {
  return {
    id: seed.revisionId,
    workspace_name: seed.workspace,
    node_id: seed.nodeId,
    revision_no: String(seed.revisionNo),
    base_revision_id: seed.baseRevisionId,
    operation_id: id21(`op${seed.revisionNo}`, seed.revisionNo),
    title: "t",
    body: "b",
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
    created_at: SEED_MICROS.toString(10),
    schema_version: "1",
    canonical_version: "arra-revision/v1",
    term_snapshot_json: JSON.stringify([TYPE_TERM]),
    link_snapshot_json: JSON.stringify(seed.links.map((link) => linkEntry(link, seed.workspace))),
    h_metadata: null,
    internal_metadata: null,
    // One pad count per link, expanded identically in the gated child. Omitted
    // entirely when nothing is padded, so ordinary seeds are unaffected.
    ...(seed.links.some((link) => (link.excerptPad ?? 0) > 0)
      ? { excerpt_pads: seed.links.map((link) => link.excerptPad ?? 0) }
      : {}),
  };
}

function nodeRow(workspace: string, nodeId: string, headId: string): Record<string, unknown> {
  return {
    id: nodeId,
    workspace_name: workspace,
    current_revision_id: headId,
    created_at: SEED_MICROS.toString(10),
    updated_at: SEED_MICROS.toString(10),
  };
}

/** What §3 says `links` must contain for a seeded revision, in wire order. */
function expectedLinkRows(seed: RevisionSeed): Record<string, unknown>[] {
  return seed.links.map((link) => {
    const target = prepared(seed.workspace, link.spec);
    return {
      workspace_name: seed.workspace,
      revision_id: seed.revisionId,
      position: String(link.position),
      relation: link.relation ?? "supports",
      target_kind: link.spec.kind,
      target: target.target_json,
      target_key: target.target_key,
      excerpt: link.excerpt ?? null,
      content_hash: null,
      captured_at: null,
      capture_status: link.capture_status ?? "locator_only",
      note: link.note ?? null,
    };
  });
}

function expectedTermRows(seed: RevisionSeed): Record<string, unknown>[] {
  return [
    {
      workspace_name: seed.workspace,
      revision_id: seed.revisionId,
      term_id: TYPE_TERM.term_id,
      vocabulary_id: TYPE_TERM.vocabulary_id,
      vocabulary_name_snapshot: TYPE_TERM.vocabulary_name_snapshot,
      term_name_snapshot: TYPE_TERM.term_name_snapshot,
      label_snapshot: null,
      position: "0",
    },
  ];
}

// ── the shared corpus ───────────────────────────────────────────────────────

const N_A = id21("nodeA", 1);
const N_B = id21("nodeB", 1);
const N_X = id21("nodeX", 1);

const A_R1: RevisionSeed = {
  workspace: W1, nodeId: N_A, revisionId: id21("arev", 1), revisionNo: 1, baseRevisionId: null,
  links: [{ position: 0, spec: TRACE_1 }, { position: 1, spec: SESSION_1 }],
};
const A_R2: RevisionSeed = {
  workspace: W1, nodeId: N_A, revisionId: id21("arev", 2), revisionNo: 2,
  baseRevisionId: A_R1.revisionId,
  links: [
    { position: 0, spec: TRACE_1 },
    { position: 1, spec: SESSION_2 },
    // The SAME trace cited again at a distinct position with a different
    // relation. §3: multiple positions targeting one identity stay separate.
    { position: 2, spec: TRACE_1, relation: "contradicts" },
  ],
};
const B_R1: RevisionSeed = {
  workspace: W1, nodeId: N_B, revisionId: id21("brev", 1), revisionNo: 1, baseRevisionId: null,
  links: [{ position: 0, spec: TRACE_2 }, { position: 1, spec: SESSION_1 }],
};
/** Another workspace citing the SAME trace id — §5 puts workspace in the key. */
const X_R1: RevisionSeed = {
  workspace: W2, nodeId: N_X, revisionId: id21("xrev", 1), revisionNo: 1, baseRevisionId: null,
  links: [{ position: 0, spec: TRACE_1 }],
};
/** Exists on disk, NOT reachable from any head. Must stay invisible. */
const A_ORPHAN: RevisionSeed = {
  workspace: W1, nodeId: N_A, revisionId: id21("aorph", 9), revisionNo: 3,
  baseRevisionId: A_R2.revisionId,
  links: [{ position: 0, spec: TRACE_2 }],
};

const CORPUS_REVISIONS = [A_R1, A_R2, B_R1, X_R1, A_ORPHAN];
const CORPUS_STEPS = [
  { op: "seed", table: "node_revisions", rows: CORPUS_REVISIONS.map(revisionRow) },
  {
    op: "seed",
    table: "nodes",
    rows: [
      nodeRow(W1, N_A, A_R2.revisionId), // head is R2; the orphan is not the head
      nodeRow(W1, N_B, B_R1.revisionId),
      nodeRow(W2, N_X, X_R1.revisionId),
    ],
  },
];

// ── plumbing ────────────────────────────────────────────────────────────────

type ChildAction =
  | { method: string; ok: true; result: Record<string, unknown> }
  | { method: string; ok: false; name: string | null; error: Record<string, unknown> };

async function runPlan(fixture: TaxonomyFixture, steps: unknown[]): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "arra-assoc68-plan-"));
  const planPath = join(dir, "plan.json");
  try {
    await writeFile(planPath, JSON.stringify({ datasetRoot: fixture.datasetRoot, steps }), "utf8");
    const run = await runGated(fixture.datasetRoot, CHILD, [planPath], {
      deadlineMs: SEED_DEADLINE_MS,
    });
    if (run.code !== 0) {
      throw new Error(`gated seed child failed (${run.code}): ${run.stderr.slice(0, 1200)}`);
    }
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writer calls run in the gated child; the parent holds no gate. */
async function runEvidence(
  fixture: TaxonomyFixture,
  actions: { method: string; request: unknown }[],
): Promise<ChildAction[]> {
  const output = await runPlan(fixture, [
    { op: "evidence", sourceNamespace: null, actions },
  ]);
  const entry = (output.results as Record<string, unknown>[]).find((row) => row.op === "evidence");
  if (entry === undefined) throw new Error("child produced no evidence result");
  return entry.actions as ChildAction[];
}

const encodeRequest = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

async function corpus(workspaces: string[] = [W1, W2]): Promise<TaxonomyFixture> {
  const fixture = await createTaxonomyFixture(workspaces);
  await runPlan(fixture, CORPUS_STEPS);
  return fixture;
}

type EvidenceReads = {
  getRevisionAssociations(bytes: Uint8Array): Promise<Record<string, unknown> | null>;
  scanDependents(bytes: Uint8Array): Promise<Record<string, unknown>>;
};

async function reader(fixture: TaxonomyFixture): Promise<EvidenceReads> {
  const api = service as unknown as Record<string, unknown>;
  const open = api.openEvidenceReader as (root: string) => Promise<Record<string, unknown>>;
  const bundle = await open(fixture.datasetRoot);
  return bundle.evidence as never;
}

/**
 * Occurrences as `node|revision|position` tuples in RAW EMITTED ORDER.
 *
 * Deliberately not sorted. §4 fixes traversal as node ID ASCII ascending, then
 * numeric accepted revision ordinal ascending, then numeric link position
 * ascending — sorting here would discard exactly the property those assertions
 * exist to check, and multiplicity with it.
 */
function occurrenceKeys(page: Record<string, unknown>): string[] {
  const rows = (page.occurrences ?? []) as Record<string, unknown>[];
  return rows.map(
    (row) => `${row.node_id}|${row.revision_id}|${(row.link as Record<string, unknown>).position}`,
  );
}

/**
 * The expected history occurrences for trace one, authored here.
 *
 * Node A only: ordinal 1 cites it at position 0, ordinal 2 cites it at 0 and
 * again at 2. Order is node, then ordinal, then position. This literal is the
 * oracle for BOTH the unpaged call and the paged walk — deriving the expectation
 * from an unpaged call would only prove the implementation agrees with itself.
 */
const HISTORY_TRACE_ONE: string[] = [
  `${N_A}|${A_R1.revisionId}|0`,
  `${N_A}|${A_R2.revisionId}|0`,
  `${N_A}|${A_R2.revisionId}|2`,
];

function scanRequest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace_name: W1,
    target_kind: TRACE_1.kind,
    target: TRACE_1.target,
    revision_mode: "current",
    limit: 100,
    cursor: null,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const marker = Symbol("no-rejection");
  let thrown: unknown = marker;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  if (thrown === marker) throw new Error("expected a rejection, got a resolved value");
  return thrown;
}

/** All four wire fields, plus the name on an actually thrown instance (§6). */
function expectThrown(
  error: unknown,
  expected: { name: string; version: string; code: string; path: string; message: string },
): void {
  const shaped = error as { name?: string; toJSON?: () => Record<string, unknown> };
  expect(shaped.name).toBe(expected.name);
  expect(shaped.toJSON?.()).toEqual({
    version: expected.version,
    code: expected.code,
    path: expected.path,
    message: expected.message,
  });
}

/**
 * Walk a whole scan from null, passing each returned cursor UNCHANGED.
 *
 * Returns the concatenated occurrence tuples in EMITTED order with multiplicity
 * intact, plus every raw page, so a caller can assert ordering, empty
 * non-terminal pages and cursor progression rather than only totals.
 */
async function fullScan(
  reads: EvidenceReads,
  request: Record<string, unknown>,
): Promise<{
  sequence: string[];
  pages: Record<string, unknown>[];
  empties: number;
  versions: string[];
}> {
  const sequence: string[] = [];
  const versions: string[] = [];
  const pages: Record<string, unknown>[] = [];
  let cursor: unknown = null;
  let empties = 0;
  for (;;) {
    const page = await reads.scanDependents(encodeRequest({ ...request, cursor }));
    if (page.outcome !== "page") {
      throw new Error(`unexpected scan outcome ${String(page.outcome)}`);
    }
    pages.push(page);
    versions.push(page.nodes_version as string);
    const batch = occurrenceKeys(page);
    if (batch.length === 0) empties += 1;
    sequence.push(...batch);
    cursor = page.next_cursor;
    // A page may be empty while continuation is nonnull; §4 says a client must
    // NOT read that as "no dependents", so the walk keeps going.
    if (cursor === null) break;
    if (pages.length > 500) throw new Error("scan did not terminate within a sane page budget");
  }
  return { sequence, pages, empties, versions };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("evidence surface", () => {
  test("service exports exactly the nine runtime names, sorted", () => {
    requireEvidenceApi();
    expect(Object.keys(service).sort()).toEqual([
      "PublicationError",
      "openContextReader",
      "openContextWriter",
      "openEvidenceReader",
      "openEvidenceWriter",
      "openKnowledgeReader",
      "openKnowledgeWriter",
      "openPublicationReader",
      "openPublicationWriter",
    ]);
  });
});

describe("authoritative associations come from the snapshot", () => {
  test(
    "complete terms and links with NO physical projection rows at all",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        const result = await reads.getRevisionAssociations(
          encodeRequest({ workspace_name: W1, node_id: N_A, revision_id: A_R2.revisionId }),
        );
        expect(result).not.toBeNull();
        const answer = result as Record<string, unknown>;
        expect(answer.node_id).toBe(N_A);
        expect(answer.revision_id).toBe(A_R2.revisionId);
        expect(answer.snapshot_head_revision_id).toBe(A_R2.revisionId);
        expect(answer.is_snapshot_head).toBe(true);
        // Nothing was ever materialized, yet the answer is complete and ordered.
        expect(answer.links).toEqual(expectedLinkRows(A_R2) as never);
        expect(answer.terms).toEqual(expectedTermRows(A_R2) as never);
        expect((answer.links as Record<string, unknown>[]).map((row) => Object.keys(row))).toEqual(
          A_R2.links.map(() => [...LINK_WIRE_ORDER]),
        );
        expect((answer.terms as Record<string, unknown>[]).map((row) => Object.keys(row))).toEqual([
          [...TERM_WIRE_ORDER],
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "absent, wrong-field, duplicate and extra projections cannot change the answer",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const expected = expectedLinkRows(A_R2);
        // Deliberately divergent derived rows: one correct, one with a wrong
        // target_key, a duplicate of position 0, an extra position that the
        // snapshot does not contain, and position 2 simply missing.
        const wrong = { ...expected[1]!, target_key: "0".repeat(64) };
        const extra = { ...expected[0]!, position: "9", relation: "related_to" };
        await runPlan(fixture, [
          { op: "seed", table: "revision_links", rows: [expected[0]!, wrong, expected[0]!, extra] },
          {
            op: "seed",
            table: "node_revision_terms",
            rows: [{ ...expectedTermRows(A_R2)[0]!, term_name_snapshot: "tampered" }],
          },
        ]);

        const reads = await reader(fixture);
        const answer = (await reads.getRevisionAssociations(
          encodeRequest({ workspace_name: W1, node_id: N_A, revision_id: A_R2.revisionId }),
        )) as Record<string, unknown>;
        // §3: missing, duplicate or wrong derived rows cannot change
        // authoritative association content. Byte-for-byte the same answer as
        // the no-projection case above.
        expect(answer.links).toEqual(expected as never);
        expect(answer.terms).toEqual(expectedTermRows(A_R2) as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a raw orphan revision is invisible, and an absent node is null",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        // The orphan row IS on disk and IS canonical; it is simply not on the
        // accepted ancestry, so it must never be served as an association.
        expect(
          await reads.getRevisionAssociations(
            encodeRequest({ workspace_name: W1, node_id: N_A, revision_id: A_ORPHAN.revisionId }),
          ),
        ).toBeNull();
        expect(
          await reads.getRevisionAssociations(
            encodeRequest({ workspace_name: W1, node_id: id21("absent", 1), revision_id: null }),
          ),
        ).toBeNull();
        // And its citation never surfaces in reverse either.
        const scan = await reads.scanDependents(
          encodeRequest(scanRequest({ target: TRACE_2.target, revision_mode: "history" })),
        );
        expect(occurrenceKeys(scan)).toEqual([
          `${N_B}|${B_R1.revisionId}|0`,
        ]);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("reverse completeness", () => {
  test(
    "current mode returns head occurrences only, repeated positions kept separate",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        const page = await reads.scanDependents(encodeRequest(scanRequest({})));
        expect(page.outcome).toBe("page");
        // Node A's head cites trace one TWICE, at positions 0 and 2. Two
        // occurrences, not one de-duplicated revision. Node B does not cite it.
        // Node X does, but in another workspace, which is a different key.
        expect(occurrenceKeys(page)).toEqual([
          `${N_A}|${A_R2.revisionId}|0`,
          `${N_A}|${A_R2.revisionId}|2`,
        ]);
        for (const row of page.occurrences as Record<string, unknown>[]) {
          expect(row.is_snapshot_head).toBe(true);
          expect(row.workspace_name).toBe(W1);
          expect(Object.keys(row.link as Record<string, unknown>)).toEqual([...LINK_WIRE_ORDER]);
        }
        // The two occurrences differ by relation, and neither was merged away.
        expect(
          (page.occurrences as Record<string, unknown>[])
            .map((row) => (row.link as Record<string, unknown>).relation)
            .sort(),
        ).toEqual(["contradicts", "supports"]);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "history mode adds the superseded revision and labels head-ness",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        const page = await reads.scanDependents(
          encodeRequest(scanRequest({ revision_mode: "history" })),
        );
        // R1 cited trace one at position 0 and is still an accepted ancestor, so
        // it is a distinct historical occurrence, not a duplicate of R2's.
        // Ordered literal, not a sorted set: node, then ordinal, then position.
        expect(occurrenceKeys(page)).toEqual(HISTORY_TRACE_ONE);
        const byRevision = new Map(
          (page.occurrences as Record<string, unknown>[]).map((row) => [
            row.revision_id,
            row.is_snapshot_head,
          ]),
        );
        expect(byRevision.get(A_R1.revisionId)).toBe(false);
        expect(byRevision.get(A_R2.revisionId)).toBe(true);
        // Oldest first per node: ordinal 1 precedes ordinal 2 in the raw order.
        const ordinals = (page.occurrences as Record<string, unknown>[]).map((row) => row.revision_no);
        expect(ordinals).toEqual(["1", "2", "2"]);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "session targets and the other workspace stay separated",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        const s1 = await reads.scanDependents(
          encodeRequest(scanRequest({ target_kind: SESSION_1.kind, target: SESSION_1.target })),
        );
        // Session one is cited by node B's head only; node A moved to session two.
        expect(occurrenceKeys(s1)).toEqual([`${N_B}|${B_R1.revisionId}|1`]);

        const s2 = await reads.scanDependents(
          encodeRequest(scanRequest({ target_kind: SESSION_2.kind, target: SESSION_2.target })),
        );
        expect(occurrenceKeys(s2)).toEqual([`${N_A}|${A_R2.revisionId}|1`]);

        // The same trace id in the OTHER workspace is a different target key, so
        // the W1 scan above never saw node X — and the W2 scan sees only it.
        const other = await reads.scanDependents(
          encodeRequest(scanRequest({ workspace_name: W2 })),
        );
        expect(occurrenceKeys(other)).toEqual([`${N_X}|${X_R1.revisionId}|0`]);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("capture identity versus display", () => {
  test(
    "two capture digests at one location are two targets; a changed title is one",
    async () => {
      requireEvidenceApi();
      const nodeC = id21("nodeC", 1);
      const nodeD = id21("nodeD", 1);
      const cRev: RevisionSeed = {
        workspace: W1, nodeId: nodeC, revisionId: id21("crev", 1), revisionNo: 1,
        baseRevisionId: null,
        links: [
          { position: 0, spec: relicEvent(DIGEST_A) },
          { position: 1, spec: relicSession("first title") },
        ],
      };
      const dRev: RevisionSeed = {
        workspace: W1, nodeId: nodeD, revisionId: id21("drev", 1), revisionNo: 1,
        baseRevisionId: null,
        links: [
          { position: 0, spec: relicEvent(DIGEST_B) },
          // Same Relic session identity, different display title.
          { position: 1, spec: relicSession("a completely different title") },
        ],
      };
      const fixture = await createTaxonomyFixture([W1]);
      try {
        await runPlan(fixture, [
          { op: "seed", table: "node_revisions", rows: [cRev, dRev].map(revisionRow) },
          {
            op: "seed",
            table: "nodes",
            rows: [nodeRow(W1, nodeC, cRev.revisionId), nodeRow(W1, nodeD, dRev.revisionId)],
          },
        ]);
        const reads = await reader(fixture);

        // Identity includes capture_digest: each digest finds only its own row.
        const a = await reads.scanDependents(
          encodeRequest(
            scanRequest({ target_kind: "relic_event", target: relicEvent(DIGEST_A).target }),
          ),
        );
        const b = await reads.scanDependents(
          encodeRequest(
            scanRequest({ target_kind: "relic_event", target: relicEvent(DIGEST_B).target }),
          ),
        );
        expect(occurrenceKeys(a)).toEqual([`${nodeC}|${cRev.revisionId}|0`]);
        expect(occurrenceKeys(b)).toEqual([`${nodeD}|${dRev.revisionId}|0`]);
        // Relational, not recomputed: disjoint, and neither empty.
        expect(occurrenceKeys(a)).not.toEqual(occurrenceKeys(b));

        // Identity EXCLUDES title_snapshot: one scan finds both, whichever
        // title the caller happens to send, and each row keeps its own text.
        for (const title of ["first title", "a completely different title", null]) {
          const both = await reads.scanDependents(
            encodeRequest(
              scanRequest({ target_kind: "relic_session", target: relicSession(title).target }),
            ),
          );
          expect(occurrenceKeys(both)).toEqual([
            `${nodeC}|${cRev.revisionId}|1`,
            `${nodeD}|${dRev.revisionId}|1`,
          ]);
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("resumable scan", () => {
  test(
    "a full walk from null with unchanged cursors returns every occurrence exactly once",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        const request = scanRequest({ revision_mode: "history" });

        // Both the unpaged call and the paged walk are compared to the SAME
        // independently authored literal. Comparing the walk to the unpaged
        // result instead would only prove the implementation agrees with itself.
        const unpaged = await reads.scanDependents(encodeRequest(request));
        expect(occurrenceKeys(unpaged)).toEqual(HISTORY_TRACE_ONE);

        // limit 1 forces a multi-page walk over the same scope. §4's
        // completeness condition is exactly this: start at null, pass each
        // returned cursor UNCHANGED, end at next_cursor null.
        const walked = await fullScan(reads, { ...request, limit: 1 });
        expect(walked.sequence).toEqual(HISTORY_TRACE_ONE);
        expect(walked.pages.length).toBeGreaterThan(1);
        // One captured version for the whole walk, never independently sampled,
        // and every nonnull returned cursor carries that same version.
        expect(new Set(walked.versions).size).toBe(1);
        for (const page of walked.pages) {
          const cursor = page.next_cursor as Record<string, unknown> | null;
          if (cursor !== null) expect(cursor.nodes_version).toBe(page.nodes_version);
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "crossing the 32-node budget with no early match yields a real empty non-terminal page",
    async () => {
      requireEvidenceApi();
      // §4 bounds a call at 32 visited node identities. Forty non-matching
      // nodes sort ASCII-before the single matching one, so the FIRST page must
      // exhaust its node budget having matched nothing: an empty page whose
      // continuation is nonnull. That is the case a client must not read as
      // "no dependents", and it cannot occur at all without enough nodes to
      // spend the budget on — which is why this needs its own fixture rather
      // than an assertion that an empty page count is non-negative.
      const FILLERS = 40;
      const VISIT_BUDGET = 32;
      const matchNode = id21("zmatch", 1);
      const matchRev: RevisionSeed = {
        workspace: W1, nodeId: matchNode, revisionId: id21("zrev", 1), revisionNo: 1,
        baseRevisionId: null, links: [{ position: 0, spec: TRACE_1 }],
      };
      // Same prefix and same length, digits last, so ASCII order is numeric
      // order and every filler sorts before "zmatch".
      const fillers: RevisionSeed[] = Array.from({ length: FILLERS }, (_, index) => ({
        workspace: W1,
        nodeId: id21("nfill", index + 1),
        revisionId: id21("nrev", index + 1),
        revisionNo: 1,
        baseRevisionId: null,
        links: [{ position: 0, spec: SESSION_1 }],
      }));
      expect(fillers.length).toBeGreaterThan(VISIT_BUDGET);
      expect(fillers.every((seed) => seed.nodeId < matchNode)).toBe(true);

      const fixture = await createTaxonomyFixture([W1]);
      try {
        const all = [...fillers, matchRev];
        await runPlan(fixture, [
          { op: "seed", table: "node_revisions", rows: all.map(revisionRow) },
          {
            op: "seed",
            table: "nodes",
            rows: all.map((seed) => nodeRow(W1, seed.nodeId, seed.revisionId)),
          },
        ]);

        const reads = await reader(fixture);
        // limit 100 is deliberately generous: the page ends because the NODE
        // budget ran out, not because the result limit did.
        const request = scanRequest({ limit: 100 });

        const first = await reads.scanDependents(encodeRequest(request));
        expect(first.outcome).toBe("page");
        expect(first.occurrences).toEqual([] as never);
        const cursor = first.next_cursor as Record<string, unknown> | null;
        // Empty AND non-terminal: progress exists even though nothing matched.
        expect(cursor).not.toBeNull();
        expect(cursor!.nodes_version).toBe(first.nodes_version as string);
        // The boundary landed on a filler, not on the match and not before the
        // start, so the cursor genuinely advanced through examined nodes.
        expect(String(cursor!.node_id) < matchNode).toBe(true);

        // Resume with that cursor UNCHANGED and the match must appear.
        const walked = await fullScan(reads, request);
        expect(walked.sequence).toEqual([`${matchNode}|${matchRev.revisionId}|0`]);
        // At least one page was empty, and the whole walk shares one version.
        expect(walked.empties).toBeGreaterThanOrEqual(1);
        expect(new Set(walked.versions).size).toBe(1);
        expect(walked.versions[0]).toBe(first.nodes_version as string);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a cursor bound to another workspace, mode or target is scope_mismatch",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        const first = await reads.scanDependents(
          encodeRequest(scanRequest({ revision_mode: "history", limit: 1 })),
        );
        const cursor = first.next_cursor as Record<string, unknown>;
        expect(cursor).not.toBeNull();

        // §6 compares workspace_name, target_kind, target_key and
        // revision_mode IN THAT ORDER, each at its own pointer, with one fixed
        // message. Asserting the pointer is what proves the order was honoured.
        const cases: [string, Record<string, unknown>][] = [
          ["/cursor/workspace_name", { ...cursor, workspace_name: W2 }],
          ["/cursor/target_kind", { ...cursor, target_kind: "session" }],
          ["/cursor/target_key", { ...cursor, target_key: "0".repeat(64) }],
          ["/cursor/revision_mode", { ...cursor, revision_mode: "current" }],
        ];
        for (const [path, bad] of cases) {
          const error = await rejection(
            reads.scanDependents(
              encodeRequest(scanRequest({ revision_mode: "history", limit: 1, cursor: bad })),
            ),
          );
          expectThrown(error, {
            name: "ContractError",
            version: "arra-error/v1",
            code: "scope_mismatch",
            path,
            message: CURSOR_MISMATCH_MESSAGE,
          });
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a nodes-version change between pages forces restart with no occurrences",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const reads = await reader(fixture);
        const request = scanRequest({ revision_mode: "history", limit: 1 });
        const first = await reads.scanDependents(encodeRequest(request));
        expect(first.outcome).toBe("page");
        const cursor = first.next_cursor as Record<string, unknown>;
        expect(cursor).not.toBeNull();

        // Append an unrelated node. §4's premise is that every accepted
        // publication changes `nodes`, so the captured witness must move and
        // the accumulated scan must be discarded — conservatively, even though
        // this node has nothing to do with the target.
        const nodeE = id21("nodeE", 1);
        const eRev: RevisionSeed = {
          workspace: W1, nodeId: nodeE, revisionId: id21("erev", 1), revisionNo: 1,
          baseRevisionId: null, links: [{ position: 0, spec: SESSION_1 }],
        };
        await runPlan(fixture, [
          { op: "seed", table: "node_revisions", rows: [revisionRow(eRev)] },
          { op: "seed", table: "nodes", rows: [nodeRow(W1, nodeE, eRev.revisionId)] },
        ]);

        const resumed = await reads.scanDependents(encodeRequest({ ...request, cursor }));
        expect(resumed).toEqual({ outcome: "restart_required" } as never);
        // A returned VALUE, not a thrown envelope, and it carries no progress
        // or churn diagnosis to be mistaken for one.
        expect(Object.keys(resumed)).toEqual(["outcome"]);

        // Restarting from null on the changed dataset succeeds again.
        // nodeE cites a session, not this trace, so the expected occurrences
        // are unchanged — asserted against the same authored literal.
        const restarted = await fullScan(reads, { ...request, cursor: null });
        expect(restarted.sequence).toEqual(HISTORY_TRACE_ONE);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("materialization", () => {
  test(
    "reconcile fills absent projections, is already_satisfied on replay, and preserves distractors",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        // Full-field distractors in ANOTHER revision and ANOTHER workspace.
        // §5 forbids touching any other (W, revision_id) set; sampling two rows
        // would not prove that, so these are compared field by field.
        const otherRevisionRows = expectedLinkRows(A_R1);
        const otherWorkspaceRows = expectedLinkRows(X_R1);
        await runPlan(fixture, [
          { op: "seed", table: "revision_links", rows: [...otherRevisionRows, ...otherWorkspaceRows] },
        ]);

        const [first, second] = await runEvidence(fixture, [
          { method: "reconcileRevisionAssociations", request: { workspace_name: W1, node_id: N_A, revision_id: A_R2.revisionId } },
          { method: "reconcileRevisionAssociations", request: { workspace_name: W1, node_id: N_A, revision_id: A_R2.revisionId } },
        ]);

        if (!first!.ok) throw new Error(`reconcile threw: ${JSON.stringify(first!.error)}`);
        const filled = first!.result;
        expect(filled.outcome).toBe("reconciled");
        expect(filled.revision_id).toBe(A_R2.revisionId);
        // Counts are the complete expected final set size, not a write tally.
        expect(filled.links).toEqual({ action: "filled", count: "3" } as never);
        expect(filled.terms).toEqual({ action: "filled", count: "1" } as never);

        if (!second!.ok) throw new Error(`replay threw: ${JSON.stringify(second!.error)}`);
        expect(second!.result.outcome).toBe("already_satisfied");
        expect(second!.result.links).toEqual({ action: "unchanged", count: "3" } as never);
        expect(second!.result.terms).toEqual({ action: "unchanged", count: "1" } as never);

        // The authoritative read is unchanged by materialization either way.
        const reads = await reader(fixture);
        const answer = (await reads.getRevisionAssociations(
          encodeRequest({ workspace_name: W1, node_id: N_A, revision_id: A_R2.revisionId }),
        )) as Record<string, unknown>;
        expect(answer.links).toEqual(expectedLinkRows(A_R2) as never);

        // Distractors survive byte-for-byte: the other revision and the other
        // workspace are still exactly what was seeded.
        const untouched = (await reads.getRevisionAssociations(
          encodeRequest({ workspace_name: W1, node_id: N_A, revision_id: A_R1.revisionId }),
        )) as Record<string, unknown>;
        expect(untouched.links).toEqual(otherRevisionRows as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reconcile refuses an orphan revision rather than materializing acceptance",
    async () => {
      requireEvidenceApi();
      const fixture = await corpus();
      try {
        const [action] = await runEvidence(fixture, [
          {
            method: "reconcileRevisionAssociations",
            request: { workspace_name: W1, node_id: N_A, revision_id: A_ORPHAN.revisionId },
          },
        ]);
        // §2: orphans are not materialized into apparent acceptance. The
        // mutation target is missing from the accepted ancestry, so this is
        // invalid_reference at its input pointer — all four wire fields.
        expect(action!.ok).toBe(false);
        const failed = action as { name: string | null; error: Record<string, unknown> };
        expect(failed.name).toBe("PublicationError");
        // The complete closed envelope, message included. Accepting any string
        // there would have left the all-four-fields claim unproved on exactly
        // the field a wrong envelope is easiest to hide in.
        expect(failed.error).toEqual({
          version: "arra-publication-error/v1",
          code: "invalid_reference",
          path: "/revision_id",
          message: SAFE_INVALID_REFERENCE,
        });
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});


// ── byte-exact response sizing ──────────────────────────────────────────────
//
// The contract pins the key order of the page object, the occurrence object and
// the link row, which is what makes a byte-exact expectation possible at all.
// Everything below is reconstructed from seeds THIS file authored; the only
// measured input is the nodes table version, which is fixture state used to
// SIZE the fixture, never as an expected value. Every digest is 64 lowercase
// hex characters, so a placeholder of the same length gives the same byte
// count as the real one.

const RESPONSE_CAP_BYTES = 16 * 1024 * 1024;
const DIGEST_PLACEHOLDER = "0".repeat(64);
const BIG_NODE = (n: number) => id21("nbig", n);
const BIG_REV = (n: number) => id21("brev", n);

function expectedOccurrence(index: number, pad: number): Record<string, unknown> {
  const target = prepared(W1, TRACE_1);
  return {
    workspace_name: W1,
    node_id: BIG_NODE(index + 1),
    revision_id: BIG_REV(index + 1),
    revision_no: "1",
    content_digest: DIGEST_PLACEHOLDER,
    snapshot_head_revision_id: BIG_REV(index + 1),
    is_snapshot_head: true,
    link: {
      workspace_name: W1,
      revision_id: BIG_REV(index + 1),
      position: "0",
      relation: "supports",
      target_kind: TRACE_1.kind,
      target: target.target_json,
      target_key: target.target_key,
      excerpt: "a".repeat(pad),
      content_hash: null,
      captured_at: null,
      capture_status: "locator_only",
      note: null,
    },
  };
}

function expectedPage(
  version: string,
  pads: number[],
  cursor: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    outcome: "page",
    nodes_version: version,
    occurrences: pads.map((pad, index) => expectedOccurrence(index, pad)),
    next_cursor: cursor,
  };
}

const wireBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** The accepted per-document bound, restated rather than imported. */
const MAX_DOCUMENT_BYTES = 1 * 1024 * 1024;

/** The 21 governed envelope keys, in codec order. */
const ENVELOPE_KEYS = [
  "workspace_name", "node_id", "base_revision_id",
  "title", "body", "body_format", "fields",
  "author_peer_name", "observer_peer_name", "subject_peer_name", "session_name",
  "is_active", "valid_from", "valid_to", "change_reason",
  "schema_version", "canonical_version",
  "term_snapshot_json", "link_snapshot_json",
  "h_metadata", "internal_metadata",
] as const;

/**
 * Canonical envelope size for one padded revision, measured not assumed.
 *
 * A pad length is not an envelope length: the excerpt sits inside a link
 * snapshot inside the canonical envelope, and it is the ENVELOPE that
 * `revisionOp` bounds. Solving pads to a 16 MiB response without checking this
 * is exactly how the previous fixture produced revisions the codec refused
 * before anything reached disk. Expanded here the same way the gated child
 * expands it, so the number is the one that will actually be staged.
 */
function envelopeBytesForPad(pad: number): number {
  const row = revisionRow({
    workspace: W1,
    nodeId: BIG_NODE(1),
    revisionId: BIG_REV(1),
    revisionNo: 1,
    baseRevisionId: null,
    links: [{ position: 0, spec: TRACE_1, excerpt: "", excerptPad: pad }],
  });
  const entries = JSON.parse(String(row.link_snapshot_json)) as Record<string, unknown>[];
  entries[0]!.excerpt = `${String(entries[0]!.excerpt ?? "")}${"a".repeat(pad)}`;
  const envelope = new Map<string, unknown>();
  for (const key of ENVELOPE_KEYS) {
    envelope.set(key, key === "link_snapshot_json" ? JSON.stringify(entries) : (row[key] ?? null));
  }
  return new TextEncoder().encode(revisionOp(envelope as never, []).canonical_json).byteLength;
}

/** Every solved pad must stage: assert the largest envelope, before seeding. */
function assertEnvelopesFit(pads: number[]): void {
  const largest = Math.max(...pads);
  const bytes = envelopeBytesForPad(largest);
  expect(bytes).toBeLessThan(MAX_DOCUMENT_BYTES);
}

/** The cursor §4 requires at a last-fitting-match boundary, or at a finished node. */
function bigCursor(
  version: string,
  nodeIndex: number,
  boundary: "last_match" | "completed_node",
): Record<string, unknown> {
  return {
    workspace_name: W1,
    target_kind: TRACE_1.kind,
    target_key: prepared(W1, TRACE_1).target_key,
    revision_mode: "current",
    nodes_version: version,
    node_id: BIG_NODE(nodeIndex),
    revision_no: boundary === "last_match" ? "1" : null,
    position: boundary === "last_match" ? "0" : null,
  };
}

/** Pads that make the WHOLE response land exactly on the cap. */
function solvePads(version: string, count: number, cursor: Record<string, unknown> | null, extra = 0): number[] {
  const bare = new Array(count).fill(0) as number[];
  const deficit = RESPONSE_CAP_BYTES - wireBytes(expectedPage(version, bare, cursor));
  const per = Math.floor(deficit / count);
  return bare.map((_, index) => per + (index === count - 1 ? deficit - per * count + extra : 0));
}

/** The nodes table version the child reported after seeding. */
function seededNodesVersion(output: Record<string, unknown>): string {
  const entry = (output.results as Record<string, unknown>[])
    .filter((row) => row.op === "seed" && row.table === "nodes")
    .at(-1);
  if (entry === undefined) throw new Error("child reported no nodes seed");
  return String(entry.version);
}

function bigSeeds(pads: number[], trailing: number): RevisionSeed[] {
  const matching: RevisionSeed[] = pads.map((pad, index) => ({
    workspace: W1,
    nodeId: BIG_NODE(index + 1),
    revisionId: BIG_REV(index + 1),
    revisionNo: 1,
    baseRevisionId: null,
    links: [{ position: 0, spec: TRACE_1, excerpt: "", excerptPad: pad }],
  }));
  // Trailing NON-matching nodes sort after every matching one, so the scan is
  // not finished when the last match is emitted and a cursor must be carried.
  const rest: RevisionSeed[] = Array.from({ length: trailing }, (_, index) => ({
    workspace: W1,
    nodeId: id21("ztail", index + 1),
    revisionId: id21("trev", index + 1),
    revisionNo: 1,
    baseRevisionId: null,
    links: [{ position: 0, spec: SESSION_1 }],
  }));
  return [...matching, ...rest];
}

async function seedBig(fixture: TaxonomyFixture, seeds: RevisionSeed[]): Promise<string> {
  const output = await runPlan(fixture, [
    { op: "seed", table: "node_revisions", rows: seeds.map(revisionRow) },
    {
      op: "seed",
      table: "nodes",
      rows: seeds.map((seed) => nodeRow(W1, seed.nodeId, seed.revisionId)),
    },
  ]);
  return seededNodesVersion(output);
}

describe("traversal budgets", () => {
  test(
    "the selected-revision budget stops a long history before the result limit does",
    async () => {
      requireEvidenceApi();
      // One node, 200 accepted revisions, only the last two citing the target.
      // History mode selects every accepted ancestor, so §4's 128 selected
      // revisions per call must stop the first page LONG before the matches —
      // and with limit 100 and zero results on that page, the result limit
      // cannot be what stopped it. 200 stays well under the per-node 1024
      // ancestry bound, and each revision is tiny, so the per-node 16 MiB
      // chain bound is not in play either.
      const CHAIN = 200;
      const MATCH_AT = [130, CHAIN];
      const node = id21("nlong", 1);
      const revisionId = (n: number) => id21("lrev", n);
      const chain: RevisionSeed[] = Array.from({ length: CHAIN }, (_, index) => {
        const ordinal = index + 1;
        return {
          workspace: W1,
          nodeId: node,
          revisionId: revisionId(ordinal),
          revisionNo: ordinal,
          baseRevisionId: ordinal === 1 ? null : revisionId(ordinal - 1),
          // Non-matching revisions still cite something, so the traversal has
          // real positions to examine rather than empty link arrays.
          links: [{ position: 0, spec: MATCH_AT.includes(ordinal) ? TRACE_1 : SESSION_1 }],
        };
      });

      const fixture = await createTaxonomyFixture([W1]);
      try {
        await runPlan(fixture, [
          { op: "seed", table: "node_revisions", rows: chain.map(revisionRow) },
          { op: "seed", table: "nodes", rows: [nodeRow(W1, node, revisionId(CHAIN))] },
        ]);

        const reads = await reader(fixture);
        const request = scanRequest({ revision_mode: "history", limit: 100 });

        const first = await reads.scanDependents(encodeRequest(request));
        expect(first.outcome).toBe("page");
        // Nothing matched yet, and the result limit of 100 is untouched, so the
        // only thing that can have ended this page is the revision budget.
        expect(first.occurrences).toEqual([] as never);
        const cursor = first.next_cursor as Record<string, unknown> | null;
        expect(cursor).not.toBeNull();
        // THE BOUNDARY IS PINNED, not measured. §4 bounds a call at 128
        // selected revisions; ordinals 1..128 each carry a single link, so
        // every one is FULLY examined and the 128th is the last. A fully
        // examined revision is exactly the "positive revision_no with position
        // null" case in §4's cursor table. A range assertion here would have
        // passed for a budget of 1 or 64 just as happily.
        expect(cursor).toEqual({
          workspace_name: W1,
          target_kind: TRACE_1.kind,
          target_key: prepared(W1, TRACE_1).target_key,
          revision_mode: "history",
          nodes_version: first.nodes_version as string,
          node_id: node,
          revision_no: "128",
          position: null,
        } as never);

        // Independently authored complete sequence: both matches, in ordinal
        // order, each at position 0.
        const expected = MATCH_AT.map((ordinal) => `${node}|${revisionId(ordinal)}|0`);
        const walked = await fullScan(reads, request);
        expect(walked.sequence).toEqual(expected);
        expect(walked.pages.length).toBeGreaterThan(1);
        expect(walked.empties).toBeGreaterThanOrEqual(1);
        expect(new Set(walked.versions).size).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the examined-position budget stops mid-revision and resumes without loss",
    async () => {
      requireEvidenceApi();
      // Three revisions of 2000 link positions each, 6000 in total, with the
      // ONLY match at the very last position. §4's 4096 examined positions per
      // call must therefore stop partway through the third revision, leaving a
      // cursor that names a position rather than a whole revision.
      const PER_REVISION = 2000;
      const REVISIONS = 3;
      const node = id21("nwide", 1);
      const revisionId = (n: number) => id21("wrev", n);
      const wide: RevisionSeed[] = Array.from({ length: REVISIONS }, (_, index) => {
        const ordinal = index + 1;
        const last = ordinal === REVISIONS;
        return {
          workspace: W1,
          nodeId: node,
          revisionId: revisionId(ordinal),
          revisionNo: ordinal,
          baseRevisionId: ordinal === 1 ? null : revisionId(ordinal - 1),
          links: Array.from({ length: PER_REVISION }, (_, position) => ({
            position,
            // Only the final position of the final revision matches.
            spec: last && position === PER_REVISION - 1 ? TRACE_1 : SESSION_1,
          })),
        };
      });

      const fixture = await createTaxonomyFixture([W1]);
      try {
        await runPlan(fixture, [
          { op: "seed", table: "node_revisions", rows: wide.map(revisionRow) },
          { op: "seed", table: "nodes", rows: [nodeRow(W1, node, revisionId(REVISIONS))] },
        ]);

        const reads = await reader(fixture);
        const request = scanRequest({ revision_mode: "history", limit: 100 });

        const first = await reads.scanDependents(encodeRequest(request));
        expect(first.outcome).toBe("page");
        expect(first.occurrences).toEqual([] as never);
        const cursor = first.next_cursor as Record<string, unknown> | null;
        expect(cursor).not.toBeNull();
        // THE BOUNDARY IS PINNED. 4096 examined positions falls as
        // 2000 + 2000 + 96: revisions one and two are consumed whole, and the
        // third is examined through its 96th position, whose zero-based index
        // is 95. §4 makes that boundary inclusive, so the cursor names
        // revision 3 at position 95. Asserting only "nonnull" would have
        // passed for almost any wrong budget.
        expect(cursor).toEqual({
          workspace_name: W1,
          target_kind: TRACE_1.kind,
          target_key: prepared(W1, TRACE_1).target_key,
          revision_mode: "history",
          nodes_version: first.nodes_version as string,
          node_id: node,
          revision_no: "3",
          position: "95",
        } as never);

        const expected = [`${node}|${revisionId(REVISIONS)}|${PER_REVISION - 1}`];
        const walked = await fullScan(reads, request);
        // The single match sits beyond the first page's boundary and must not
        // be skipped by the resumption.
        expect(walked.sequence).toEqual(expected);
        expect(walked.pages.length).toBeGreaterThan(1);
        expect(new Set(walked.versions).size).toBe(1);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the 16 MiB response cap splits pages and carries the next match forward",
    async () => {
      requireEvidenceApi();
      // Twenty nodes, one revision each, one matching link each, with a ~1 MiB
      // excerpt. Twenty megabytes of occurrences cannot fit one response, so
      // §4's cap must split them. Spread across NODES on purpose: a single
      // node's chain must stay under its own 16 MiB ancestry bound, which one
      // twenty-megabyte chain would breach for a different reason entirely.
      const NODES = 20;
      const EXCERPT_BYTES = 1_000_000;
      const RESPONSE_CAP = 16 * 1024 * 1024;
      const node = (n: number) => id21("nbig", n);
      const revisionId = (n: number) => id21("brev", n);
      const seeds: RevisionSeed[] = Array.from({ length: NODES }, (_, index) => ({
        workspace: W1,
        nodeId: node(index + 1),
        revisionId: revisionId(index + 1),
        revisionNo: 1,
        baseRevisionId: null,
        links: [{ position: 0, spec: TRACE_1, excerpt: "", excerptPad: EXCERPT_BYTES }],
      }));

      const fixture = await createTaxonomyFixture([W1]);
      try {
        await runPlan(fixture, [
          { op: "seed", table: "node_revisions", rows: seeds.map(revisionRow) },
          {
            op: "seed",
            table: "nodes",
            rows: seeds.map((seed) => nodeRow(W1, seed.nodeId, seed.revisionId)),
          },
        ]);

        const reads = await reader(fixture);
        // limit 100 exceeds the twenty available matches, so the result limit
        // cannot be what splits these pages: only the byte cap can.
        const request = scanRequest({ limit: 100 });

        const walked = await fullScan(reads, request);

        // Independently authored: every node contributes exactly one
        // occurrence at position 0, in node-ID ASCII order.
        const expected = Array.from(
          { length: NODES },
          (_, index) => `${node(index + 1)}|${revisionId(index + 1)}|0`,
        );
        expect(walked.sequence).toEqual(expected);
        // Split happened, and no page reached the untouched result limit.
        expect(walked.pages.length).toBeGreaterThan(1);
        for (const page of walked.pages) {
          expect((page.occurrences as unknown[]).length).toBeLessThan(100);
          // The WHOLE forward response, cursor and control fields included, is
          // measured here rather than just the occurrence array.
          const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
          expect(bytes).toBeLessThanOrEqual(RESPONSE_CAP);
        }
        // At least one page had to carry a real load rather than dribbling one
        // occurrence at a time, otherwise "cap" would not be what split them.
        expect(
          Math.max(...walked.pages.map((page) => (page.occurrences as unknown[]).length)),
        ).toBeGreaterThan(1);
        expect(new Set(walked.versions).size).toBe(1);
        // Nothing lost and nothing repeated across the split.
        expect(new Set(walked.sequence).size).toBe(walked.sequence.length);

      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("response cap, sized independently", () => {
  /**
   * These three share one shape: the response is reconstructed here from
   * authored seeds and SOLVED to a byte target, so the assertion is an
   * expectation rather than a reading. A cap test that only checks
   * `<= 16 MiB` passes just as well against an 8 MiB implementation, and
   * "more than one occurrence on a page" proves nothing about which rule
   * ended the page.
   */

  test(
    "a response landing exactly on the cap is served whole, with no continuation",
    async () => {
      requireEvidenceApi();
      // Twenty matching nodes: sixteen would need ~1 MiB per occurrence, and a
      // revision whose canonical envelope exceeds the accepted 1 MiB
      // per-document bound is refused by the codec before it can be staged.
      // Twenty leaves each envelope comfortably inside that bound while still
      // summing to the 16 MiB response cap.
      const COUNT = 20;
      const fixture = await createTaxonomyFixture([W1]);
      try {
        // Size against a null cursor: nothing trails the matches, so the scan
        // finishes on this page and §4 allows exact equality with the cap.
        const probe = await createTaxonomyFixture([W1]);
        let version: string;
        try {
          version = await seedBig(probe, bigSeeds(new Array(COUNT).fill(0), 0));
        } finally {
          await probe.cleanup();
        }
        const pads = solvePads(version, COUNT, null);
        expect(wireBytes(expectedPage(version, pads, null))).toBe(RESPONSE_CAP_BYTES);
        // Independent fixture bound, checked BEFORE staging.
        assertEnvelopesFit(pads);

        const actualVersion = await seedBig(fixture, bigSeeds(pads, 0));
        // The sizing probe and the real fixture must agree, or the solved pads
        // describe a different response than the one under test.
        expect(actualVersion).toBe(version);

        const reads = await reader(fixture);
        const page = await reads.scanDependents(encodeRequest(scanRequest({ limit: 100 })));
        expect(page.outcome).toBe("page");
        expect(page.nodes_version).toBe(version);
        expect(page.next_cursor).toBeNull();
        expect(occurrenceKeys(page)).toEqual(
          Array.from({ length: COUNT }, (_, index) => `${BIG_NODE(index + 1)}|${BIG_REV(index + 1)}|0`),
        );
        // Equality with the cap is ACCEPTED, and it is the whole forward
        // response that is measured, control fields included.
        expect(wireBytes(page)).toBe(RESPONSE_CAP_BYTES);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "one byte over the cap continues instead of dropping the last occurrence",
    async () => {
      requireEvidenceApi();
      // Twenty matching nodes: sixteen would need ~1 MiB per occurrence, and a
      // revision whose canonical envelope exceeds the accepted 1 MiB
      // per-document bound is refused by the codec before it can be staged.
      // Twenty leaves each envelope comfortably inside that bound while still
      // summing to the 16 MiB response cap.
      const COUNT = 20;
      const fixture = await createTaxonomyFixture([W1]);
      try {
        const probe = await createTaxonomyFixture([W1]);
        let version: string;
        try {
          version = await seedBig(probe, bigSeeds(new Array(COUNT).fill(0), 0));
        } finally {
          await probe.cleanup();
        }
        // Exactly one byte past the accepted case above.
        const pads = solvePads(version, COUNT, null, 1);
        expect(wireBytes(expectedPage(version, pads, null))).toBe(RESPONSE_CAP_BYTES + 1);
        assertEnvelopesFit(pads);

        expect(await seedBig(fixture, bigSeeds(pads, 0))).toBe(version);
        const reads = await reader(fixture);
        const request = scanRequest({ limit: 100 });

        const first = await reads.scanDependents(encodeRequest(request));
        expect(first.outcome).toBe("page");
        expect(wireBytes(first)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
        // The page could not hold everything, so it must stop short and carry
        // a continuation rather than silently truncating.
        expect((first.occurrences as unknown[]).length).toBeLessThan(COUNT);
        expect(first.next_cursor).not.toBeNull();

        const expected = Array.from(
          { length: COUNT },
          (_, index) => `${BIG_NODE(index + 1)}|${BIG_REV(index + 1)}|0`,
        );
        const walked = await fullScan(reads, request);
        // Nothing dropped, nothing repeated, order preserved across the split.
        expect(walked.sequence).toEqual(expected);
        expect(new Set(walked.sequence).size).toBe(COUNT);
        for (const page of walked.pages) {
          expect(wireBytes(page)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an unfinished scan takes the last-fitting-match boundary, not a larger completed-node one",
    async () => {
      requireEvidenceApi();
      // The discriminating case for cursor/control accounting.
      //
      // CORRECTED FIXTURE: trailing non-matching nodes do NOT by themselves
      // make a scan unfinished. A total under §4's 32 visited identities lets
      // the scan finish, so a null continuation is entirely legitimate — an
      // earlier version of this test asserted a split the contract never
      // required.
      //
      // Twenty matches plus thirteen trailing nodes is 33, so the node budget
      // stops the page at 32 with nodes still to visit and a cursor MUST be
      // emitted.
      // The pads are then solved against that real cursor, so all sixteen
      // matches plus the cursor land exactly on the cap.
      //
      // What that discriminates: §4 offers two usable boundaries, the last
      // examined link and the last completed node. With equal-length ids the
      // completed-node form is `null,null` where the match form is `"1","0"`,
      // and `null` is one byte longer than a quoted single digit — measured,
      // 252 bytes against 250. So an implementation that advanced to a
      // completed-node boundary here would emit a 16 MiB + 2 response. Taking
      // the last-fitting-match boundary is the only way to stay at the cap
      // without dropping a match.
      const COUNT = 20;
      const TRAILING = 13;
      const VISIT_BUDGET = 32;
      expect(COUNT + TRAILING).toBeGreaterThan(VISIT_BUDGET);

      const fixture = await createTaxonomyFixture([W1]);
      try {
        const probe = await createTaxonomyFixture([W1]);
        let version: string;
        try {
          version = await seedBig(probe, bigSeeds(new Array(COUNT).fill(0), TRAILING));
        } finally {
          await probe.cleanup();
        }

        const matchBoundary = bigCursor(version, COUNT, "last_match");
        const completedBoundary = bigCursor(version, COUNT, "completed_node");
        // Independently verified before any run: the completed-node cursor is
        // strictly larger, which is what makes this fixture discriminating.
        expect(wireBytes(completedBoundary)).toBeGreaterThan(wireBytes(matchBoundary));

        const pads = solvePads(version, COUNT, matchBoundary);
        expect(wireBytes(expectedPage(version, pads, matchBoundary))).toBe(RESPONSE_CAP_BYTES);
        assertEnvelopesFit(pads);
        // The same occurrences under the larger boundary would not fit.
        expect(wireBytes(expectedPage(version, pads, completedBoundary))).toBeGreaterThan(
          RESPONSE_CAP_BYTES,
        );

        expect(await seedBig(fixture, bigSeeds(pads, TRAILING))).toBe(version);
        const reads = await reader(fixture);
        const request = scanRequest({ limit: 100 });

        const first = await reads.scanDependents(encodeRequest(request));
        expect(first.outcome).toBe("page");
        expect(first.nodes_version).toBe(version);
        // Every match is kept — the fallback is a smaller BOUNDARY, never a
        // dropped occurrence.
        expect(occurrenceKeys(first)).toEqual(
          Array.from({ length: COUNT }, (_, index) => `${BIG_NODE(index + 1)}|${BIG_REV(index + 1)}|0`),
        );
        expect(first.next_cursor).toEqual(matchBoundary as never);
        expect(wireBytes(first)).toBe(RESPONSE_CAP_BYTES);

        // Resuming walks the remaining non-matching nodes to exhaustion and
        // adds nothing, so the complete sequence is still exactly the matches.
        const walked = await fullScan(reads, request);
        expect(walked.sequence).toEqual(
          Array.from({ length: COUNT }, (_, index) => `${BIG_NODE(index + 1)}|${BIG_REV(index + 1)}|0`),
        );
        expect(new Set(walked.sequence).size).toBe(COUNT);
        expect(walked.pages.length).toBeGreaterThan(1);
        for (const page of walked.pages) {
          expect(wireBytes(page)).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
