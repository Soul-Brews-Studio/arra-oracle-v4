// #26 §9 evidence — stored reference and policy validation before any append.
//
// Authority is `app/docs/contracts/revision-publication-v1.md`
// (SHA256 387272dc8655319f877ef2bb4926caf0127c3712373b1309084e2d00172a9f9c) §5, §8
// and §9 bullet 6. Writer exclusion and facade shape are `publication-ownership.test.ts`;
// crash reconstruction is `publication-recovery.test.ts`; envelope bytes and digests are
// the governed codec's own tests. Nothing here re-tests canonical syntax.
//
// Why this file exists. The canonical codec proves an envelope is well FORMED — that a
// term entry has the right keys and a timestamp the right shape. It cannot prove the term
// exists in this workspace, that its vocabulary policy permits the assignment, or that a
// linked message belongs to the session it claims. Those are STORED-state questions, and
// §5 puts them under the writer gate before a single row is appended. So every case below
// runs against a real gated, seeded, disposable target19 dataset with two independently
// seeded workspaces — never a lookup map that always says yes.
//
// How a rejection is proved to have cost nothing:
//
// * Per case, the child reads the node back through the service: an absent node is exactly
//   `null` (§2), so a case that had appended anything would show `present`.
// * Per batch, the parent compares every table's row count and table version before and
//   after, read independently through Python rather than through the service under test.
//   If any single rejection had appended, that comparison changes. The accepted-baseline
//   suite runs the same comparison and REQUIRES it to differ, which is what makes the
//   unchanged comparisons meaningful rather than vacuous.
//
// Fail-if-used dependencies: every child replaces `fetch` with a thrower that announces
// itself, and runs with a deliberately invalid `OLLAMA_URL`. Any model or network call on
// the authoritative path would surface as a `net:used` event, and no test tolerates one.
// This is a runtime check; the source-text import guard is the main-owned IsolationTests'
// job, and nothing here claims to replace it.
//
// Bounded claims: this is one local cooperative-gate dataset per case, seeded by the
// accepted Python exporter. It says nothing about concurrent external writers, about
// Linux/NFS/R2, or about references whose truth lives outside the dataset — §5 keeps
// external locators passive and this file never dereferences one.
//
// Interpreter: `ARRA_CONTRACT_PYTHON` must point at an interpreter that can import
// `lancedb`, exactly as the existing cross-language tests require. When it cannot, every
// suite here skips with the blocker in its title rather than reporting green.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Fixture,
  type SeededTerm,
  type SeededWorkspace,
  PYTHON,
  createFixture,
  runGated,
  runOwnedChild,
} from "../../helpers/publication-fixture";
import { testTimeout } from "../../helpers/timing.testTimeout";

const TEST_DIR = resolve(import.meta.dir, "..", "..");
const SERVER_DIR = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(SERVER_DIR, "..", "..");
const PY_SRC = join(REPO_ROOT, "app", "migrate-py", "src");
const SERVICE_MODULE = join(SERVER_DIR, "src", "publication", "service.ts");
const HELPER_MODULE = join(TEST_DIR, "helpers", "publication-fixture.ts");

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const TEST_TIMEOUT_MS = testTimeout(180_000);
const FIXED_CLOCK_MS = 1_789_905_600_000;

// ── case description, shared with the child ──────────────────────────────────

type PublishCase = {
  name: string;
  workspace: string;
  node_id: string;
  operation_id: string;
  overrides?: Record<string, unknown>;
  /**
   * Resolve a `node_revision` link against the accepted head of an earlier node
   * in the same run. The revision id cannot be known before that publication,
   * so the child reads it back and substitutes it.
   */
  link_to_head_of?: string;
};

/** A nanoid21 node id that still says which case it belongs to. */
const nodeId = (slot: number): string => `n${String(slot).padStart(2, "0")}${"_".repeat(18)}`;

const termEntry = (term: SeededTerm, position: number, overrides: Record<string, unknown> = {}) => ({
  term_id: term.id,
  vocabulary_id: term.vocabulary_id,
  vocabulary_name_snapshot: term.vocabulary_name,
  term_name_snapshot: term.name,
  label_snapshot: null,
  position: String(position),
  ...overrides,
});

const termsJson = (...entries: Record<string, unknown>[]) => JSON.stringify(entries);

const linkEntry = (position: number, targetKind: string, target: Record<string, unknown>) => ({
  position: String(position),
  relation: "related_to",
  target_kind: targetKind,
  target,
  excerpt: null,
  content_hash: null,
  captured_at: null,
  capture_status: "locator_only",
  note: null,
});

const linksJson = (...entries: Record<string, unknown>[]) => JSON.stringify(entries);

// ── children ─────────────────────────────────────────────────────────────────

const scripts = mkdtempSync(join(tmpdir(), "arra-v4-references-"));
const scriptPath = (name: string) => join(scripts, name);

/**
 * Publish every supplied case through the gated service and report the outcome
 * of each, then read the node back so an append cannot hide behind a rejection.
 */
const CASES_TS = `import { openPublicationWriter } from ${JSON.stringify(SERVICE_MODULE)};
import { encodeRequest, idSource, revisionEnvelope } from ${JSON.stringify(HELPER_MODULE)};

// Fail-if-used: the authoritative path must never call a model or the network.
globalThis.fetch = (() => {
  console.log("EVENT net:used");
  throw new Error("network is fail-if-used in this test child");
}) as unknown as typeof fetch;

const [, , root, seedPath, casesPath] = process.argv;
const seeds = JSON.parse(await Bun.file(seedPath!).text());
const cases = JSON.parse(await Bun.file(casesPath!).text());

const service = await openPublicationWriter(root!, {
  newRevisionId: idSource("ref"),
  clock: () => ${FIXED_CLOCK_MS},
});

const readHead = (workspace: string, node: string) =>
  service.getAcceptedHead(encodeRequest({ workspace_name: workspace, node_id: node }));

const acceptedHeads = new Map<string, string>();

for (const item of cases) {
  const overrides = { ...(item.overrides ?? {}) };
  if (typeof item.link_to_head_of === "string") {
    // The link target's revision id only exists once that node is accepted.
    const head = (await readHead(item.workspace, item.link_to_head_of)) as
      | { revision: { id: string } }
      | null;
    const revisionId = head === null ? "missing-head" : head.revision.id;
    overrides.link_snapshot_json = JSON.stringify([
      {
        position: "0",
        relation: "related_to",
        target_kind: "node_revision",
        target: { node_id: item.link_to_head_of, revision_id: revisionId },
        excerpt: null,
        content_hash: null,
        captured_at: null,
        capture_status: "locator_only",
        note: null,
      },
    ]);
  }

  const content = revisionEnvelope(item.workspace, seeds[item.workspace], item.node_id, overrides);
  const outcome = await service
    .publishRevision(encodeRequest({ operation_id: item.operation_id, content }))
    .then(
      (value: unknown) => \`accepted \${(value as { outcome?: string }).outcome ?? "no-outcome"}\`,
      (error: unknown) => {
        const shaped = error as { code?: string; path?: string; name?: string };
        // A governed codec error keeps its OWN envelope and is reported as such
        // rather than being relabelled into a publication code.
        if (shaped.name === "ContractError") return \`contract \${shaped.code ?? "no-code"}\`;
        return \`\${shaped.code ?? "no-code"} \${shaped.path ?? "no-path"}\`;
      },
    );
  console.log(\`EVENT case \${item.name} :: \${outcome}\`);

  const head = await readHead(item.workspace, item.node_id);
  if (head !== null) acceptedHeads.set(item.node_id, "present");
  console.log(\`EVENT node \${item.name} :: \${head === null ? "absent" : "present"}\`);
}

await service.close();
console.log("EVENT done");
`;

/** Table names, row counts and versions, observed WITHOUT the service. */
const COUNT_PY = `import json, sys
import lancedb

db = lancedb.connect(sys.argv[1])
state = {}
for name in sorted(db.table_names()):
    table = db.open_table(name)
    state[name] = {"rows": table.count_rows(), "version": table.version}
print(json.dumps(state, sort_keys=True))
`;

/**
 * Corrupt a disposable copy under the writer gate, the way any other writer must.
 *
 * `clone` appends a copy of the matched rows with optional field overrides, which
 * is how a duplicate logical identity is produced. `update` rewrites fields in
 * place, which is how a policy column is made malformed. Both are deliberate
 * corruption of a copy — never of the reference dataset, and never a new
 * dataset creator.
 */
const CORRUPT_PY = `import json, sys
import pyarrow as pa
import pyarrow.compute as pc
import lancedb
from arra_migrate.writer_gate import writer_gate

root, op, table_name = sys.argv[1], sys.argv[2], sys.argv[3]
match = json.loads(sys.argv[4])
overrides = json.loads(sys.argv[5])

with writer_gate(root):
    db = lancedb.connect(root)
    table = db.open_table(table_name)
    data = table.to_arrow()

    mask = None
    for field, value in match.items():
        column_type = data.schema.field(field).type
        comparison = pc.equal(data[field], pa.scalar(value, type=column_type))
        mask = comparison if mask is None else pc.and_(mask, comparison)
    selected = data.filter(mask)
    if selected.num_rows == 0:
        raise SystemExit("corruption matched no rows: " + json.dumps(match))

    if op == "clone":
        for field, value in overrides.items():
            index = selected.schema.get_field_index(field)
            field_type = selected.schema.field(index).type
            column = pa.array([value] * selected.num_rows, type=field_type)
            selected = selected.set_column(index, selected.schema.field(index), column)
        table.add(selected)
    elif op == "update":
        where = " AND ".join(f"{k} = '{v}'" for k, v in match.items())
        table.update(where=where, values=overrides)
    else:
        raise SystemExit("unknown corruption op: " + op)

print("CORRUPTED " + op + " " + table_name + " rows=" + str(selected.num_rows))
`;

writeFileSync(scriptPath("cases.ts"), CASES_TS, { mode: 0o600 });
writeFileSync(scriptPath("count.py"), COUNT_PY, { mode: 0o600 });
writeFileSync(scriptPath("corrupt.py"), CORRUPT_PY, { mode: 0o600 });

// ── fixture and scratch ──────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-references-data-"));

/**
 * One reference dataset, seeded once with TWO independent workspaces; every test
 * works on its own copy so no test can observe another's writes.
 */
const fixture: Fixture | null = await createFixture([ALPHA, BETA]).catch(() => null);
const READY = fixture !== null;
const PENDING = "needs a seeded target19 fixture — set ARRA_CONTRACT_PYTHON to an interpreter with lancedb";

const alphaSeed = (fixture?.workspaces[ALPHA] ?? {}) as SeededWorkspace;
const betaSeed = (fixture?.workspaces[BETA] ?? {}) as SeededWorkspace;

function copyFixture(name: string): string {
  const root = join(scratch, name);
  const copied = Bun.spawnSync(["cp", "-R", fixture!.datasetRoot, root]);
  expect(copied.exitCode).toBe(0);
  return root;
}

/** Row counts and table versions for all 19 tables, read independently. */
async function datasetState(root: string): Promise<string> {
  const run = await runOwnedChild(PYTHON, [scriptPath("count.py"), root], {
    env: { PYTHONPATH: PY_SRC },
  });
  expect(run.code).toBe(0);
  return run.stdout.trim();
}

async function corrupt(
  root: string,
  op: "clone" | "update",
  table: string,
  match: Record<string, string>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const run = await runOwnedChild(
    PYTHON,
    [scriptPath("corrupt.py"), root, op, table, JSON.stringify(match), JSON.stringify(overrides)],
    { env: { PYTHONPATH: PY_SRC } },
  );
  expect({ op, table, code: run.code, stderr: run.stderr.slice(-200) }).toEqual({
    op,
    table,
    code: 0,
    stderr: "",
  });
}

type CaseOutcome = { outcome: string; node: string };

/** Run cases inside the gate and return each case's outcome and node state. */
async function runCases(root: string, cases: PublishCase[]): Promise<Map<string, CaseOutcome>> {
  const seedPath = join(scratch, `seeds-${Math.random().toString(36).slice(2)}.json`);
  const casesPath = join(scratch, `cases-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(seedPath, JSON.stringify(fixture!.workspaces), { mode: 0o600 });
  writeFileSync(casesPath, JSON.stringify(cases), { mode: 0o600 });

  const run = await runGated(root, scriptPath("cases.ts"), [root, seedPath, casesPath], {
    // Fail-if-used: a real embedder URL must never be reachable from here.
    env: { OLLAMA_URL: "http://model-must-not-be-called.invalid" },
  });

  const events = run.stdout
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => line.slice("EVENT ".length).trim());

  // A model or network call anywhere on the authoritative path fails the run.
  expect(events).not.toContain("net:used");
  expect({ events, stderr: run.stderr.slice(-400) }).toEqual({
    events: expect.arrayContaining(["done"]),
    stderr: run.stderr.slice(-400),
  });

  const outcomes = new Map<string, CaseOutcome>();
  for (const event of events) {
    const caseMatch = /^case (\S+) :: (.+)$/.exec(event);
    if (caseMatch !== null) {
      const existing = outcomes.get(caseMatch[1]!) ?? { outcome: "", node: "" };
      outcomes.set(caseMatch[1]!, { ...existing, outcome: caseMatch[2]! });
    }
    const nodeMatch = /^node (\S+) :: (.+)$/.exec(event);
    if (nodeMatch !== null) {
      const existing = outcomes.get(nodeMatch[1]!) ?? { outcome: "", node: "" };
      outcomes.set(nodeMatch[1]!, { ...existing, node: nodeMatch[2]! });
    }
  }
  return outcomes;
}

/** Compare every case against its expected `code path` outcome, in one assertion. */
function expectOutcomes(
  actual: Map<string, CaseOutcome>,
  expected: Record<string, string>,
  nodeState: "absent" | "present",
): void {
  const flattened: Record<string, string> = {};
  const wanted: Record<string, string> = {};
  for (const [name, outcome] of Object.entries(expected)) {
    flattened[name] = `${actual.get(name)?.outcome ?? "MISSING"} | node ${actual.get(name)?.node ?? "MISSING"}`;
    wanted[name] = `${outcome} | node ${nodeState}`;
  }
  expect(flattened).toEqual(wanted);
}

afterAll(async () => {
  rmSync(scripts, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  await fixture?.cleanup();
});

// ── accepted baselines, which make every rejection below refutable ───────────

describe.skipIf(!READY)(`accepted reference baselines [${PENDING}]`, () => {
  test(
    "genuinely valid references in two independent workspaces are accepted and do change the dataset",
    async () => {
      const root = copyFixture("accepted");
      const before = await datasetState(root);

      const cases: PublishCase[] = [
        {
          name: "alpha-minimal",
          workspace: ALPHA,
          node_id: nodeId(1),
          operation_id: "accept-alpha-minimal",
        },
        {
          // The same shape in a SEPARATE workspace, using beta's own seeded
          // peers, session and terms: two workspaces, not one with two labels.
          name: "beta-minimal",
          workspace: BETA,
          node_id: nodeId(2),
          operation_id: "accept-beta-minimal",
        },
        {
          name: "alpha-full-attribution",
          workspace: ALPHA,
          node_id: nodeId(3),
          operation_id: "accept-alpha-full",
          overrides: {
            observer_peer_name: alphaSeed.peer_names[1],
            subject_peer_name: alphaSeed.peer_names[0],
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0),
              termEntry(alphaSeed.term_ids.memory_horizon.short_term!, 1),
              // A SEALED vocabulary still permits assigning an existing active
              // term: sealing governs term creation, not assignment (§5).
              termEntry(alphaSeed.term_ids.topic.storage!, 2),
            ),
          },
        },
        {
          name: "alpha-external-locator",
          workspace: ALPHA,
          node_id: nodeId(4),
          operation_id: "accept-alpha-url",
          overrides: {
            // An external locator stays passive: validated in shape, never
            // fetched, never resolved, never handed to a model.
            link_snapshot_json: linksJson(linkEntry(0, "url", { url: "https://example.invalid/a" })),
          },
        },
        {
          name: "alpha-single-validity-bound",
          workspace: ALPHA,
          node_id: nodeId(5),
          operation_id: "accept-alpha-one-bound",
          // §5 checks the interval only when BOTH bounds are present.
          overrides: { valid_from: "2026-09-20T00:00:00.000Z" },
        },
        {
          name: "alpha-revision-link",
          workspace: ALPHA,
          node_id: nodeId(6),
          operation_id: "accept-alpha-revision-link",
          // Resolved from the accepted head of alpha-minimal, published above.
          link_to_head_of: nodeId(1),
        },
      ];

      const outcomes = await runCases(root, cases);
      expectOutcomes(
        outcomes,
        Object.fromEntries(cases.map((item) => [item.name, "accepted accepted"])),
        "present",
      );

      // The positive control for every "unchanged" assertion in this file: the
      // same measurement DOES move when a publication really is accepted.
      expect(await datasetState(root)).not.toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "internal message, session and trace links resolve against their own workspace",
    async () => {
      const root = copyFixture("accepted-links");
      const cases: PublishCase[] = [
        {
          name: "alpha-session-link",
          workspace: ALPHA,
          node_id: nodeId(7),
          operation_id: "accept-session-link",
          overrides: {
            link_snapshot_json: linksJson(
              linkEntry(0, "session", { session_name: alphaSeed.session_name }),
            ),
          },
        },
        {
          name: "alpha-message-link",
          workspace: ALPHA,
          node_id: nodeId(8),
          operation_id: "accept-message-link",
          overrides: {
            link_snapshot_json: linksJson(
              linkEntry(0, "message", {
                session_name: alphaSeed.session_name,
                message_public_id: alphaSeed.message_public_id,
              }),
            ),
          },
        },
        {
          name: "alpha-trace-link",
          workspace: ALPHA,
          node_id: nodeId(9),
          operation_id: "accept-trace-link",
          overrides: {
            link_snapshot_json: linksJson(linkEntry(0, "trace", { trace_id: alphaSeed.trace_id })),
          },
        },
      ];

      const outcomes = await runCases(root, cases);
      // §5: "message requires exact session+public_id and valid session; session
      // requires exact name; trace requires exact ID". Each of these targets IS
      // the seeded row in its own workspace, so each must resolve.
      expectOutcomes(
        outcomes,
        {
          "alpha-session-link": "accepted accepted",
          "alpha-message-link": "accepted accepted",
          "alpha-trace-link": "accepted accepted",
        },
        "present",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// ── missing and cross-workspace references ───────────────────────────────────

describe.skipIf(!READY)(`missing and cross-workspace references [${PENDING}]`, () => {
  test(
    "every unresolvable domain, term or link reference is rejected with nothing appended",
    async () => {
      const root = copyFixture("invalid-references");
      const before = await datasetState(root);

      const cases: PublishCase[] = [
        {
          name: "absent-author-peer",
          workspace: ALPHA,
          node_id: nodeId(10),
          operation_id: "reject-absent-peer",
          overrides: { author_peer_name: "no-such-peer" },
        },
        {
          // Beta's peer is a real row — in the WRONG workspace. A check that
          // forgot to scope by workspace would accept this.
          name: "cross-workspace-author-peer",
          workspace: ALPHA,
          node_id: nodeId(11),
          operation_id: "reject-cross-peer",
          overrides: { author_peer_name: betaSeed.peer_names[0] },
        },
        {
          name: "cross-workspace-observer-peer",
          workspace: ALPHA,
          node_id: nodeId(12),
          operation_id: "reject-cross-observer",
          overrides: { observer_peer_name: betaSeed.peer_names[1] },
        },
        {
          name: "cross-workspace-session",
          workspace: ALPHA,
          node_id: nodeId(13),
          operation_id: "reject-cross-session",
          overrides: { session_name: betaSeed.session_name },
        },
        {
          name: "absent-session",
          workspace: ALPHA,
          node_id: nodeId(14),
          operation_id: "reject-absent-session",
          overrides: { session_name: "no-such-session" },
        },
        {
          name: "cross-workspace-term",
          workspace: ALPHA,
          node_id: nodeId(15),
          operation_id: "reject-cross-term",
          overrides: { term_snapshot_json: termsJson(termEntry(betaSeed.term_ids.type.note!, 0)) },
        },
        {
          // The term exists in this workspace, but is claimed to belong to a
          // different vocabulary than the one that actually owns it.
          name: "term-vocabulary-mismatch",
          workspace: ALPHA,
          node_id: nodeId(16),
          operation_id: "reject-term-vocab",
          overrides: {
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0, {
                vocabulary_id: alphaSeed.vocabulary_ids.topic,
              }),
            ),
          },
        },
        {
          name: "term-name-snapshot-mismatch",
          workspace: ALPHA,
          node_id: nodeId(17),
          operation_id: "reject-term-name",
          overrides: {
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0, { term_name_snapshot: "decision" }),
            ),
          },
        },
        {
          name: "vocabulary-name-snapshot-mismatch",
          workspace: ALPHA,
          node_id: nodeId(18),
          operation_id: "reject-vocab-name",
          overrides: {
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0, { vocabulary_name_snapshot: "topic" }),
            ),
          },
        },
        {
          // Retired terms stay readable in history but cannot be newly assigned.
          name: "retired-term-assignment",
          workspace: ALPHA,
          node_id: nodeId(19),
          operation_id: "reject-retired-term",
          overrides: {
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0),
              termEntry(alphaSeed.term_ids.topic.retired_topic!, 1),
            ),
          },
        },
        {
          name: "link-absent-session",
          workspace: ALPHA,
          node_id: nodeId(20),
          operation_id: "reject-link-session",
          overrides: {
            link_snapshot_json: linksJson(linkEntry(0, "session", { session_name: "no-such-session" })),
          },
        },
        {
          name: "link-cross-workspace-trace",
          workspace: ALPHA,
          node_id: nodeId(21),
          operation_id: "reject-link-trace",
          overrides: {
            link_snapshot_json: linksJson(linkEntry(0, "trace", { trace_id: betaSeed.trace_id })),
          },
        },
        {
          name: "link-cross-workspace-message",
          workspace: ALPHA,
          node_id: nodeId(22),
          operation_id: "reject-link-message",
          overrides: {
            link_snapshot_json: linksJson(
              linkEntry(0, "message", {
                session_name: betaSeed.session_name,
                message_public_id: betaSeed.message_public_id,
              }),
            ),
          },
        },
        {
          // Alpha's own session, but beta's message: the pair must match, not
          // merely each exist somewhere.
          name: "link-mismatched-message-session",
          workspace: ALPHA,
          node_id: nodeId(23),
          operation_id: "reject-link-message-pair",
          overrides: {
            link_snapshot_json: linksJson(
              linkEntry(0, "message", {
                session_name: alphaSeed.session_name,
                message_public_id: betaSeed.message_public_id,
              }),
            ),
          },
        },
        {
          name: "link-absent-node-revision",
          workspace: ALPHA,
          node_id: nodeId(24),
          operation_id: "reject-link-node",
          overrides: {
            link_snapshot_json: linksJson(
              linkEntry(0, "node_revision", {
                node_id: nodeId(90),
                revision_id: "z".repeat(21),
              }),
            ),
          },
        },
      ];

      const outcomes = await runCases(root, cases);
      expectOutcomes(
        outcomes,
        {
          "absent-author-peer": "invalid_reference /content/author_peer_name",
          "cross-workspace-author-peer": "invalid_reference /content/author_peer_name",
          "cross-workspace-observer-peer": "invalid_reference /content/observer_peer_name",
          "cross-workspace-session": "invalid_reference /content/session_name",
          "absent-session": "invalid_reference /content/session_name",
          "cross-workspace-term": "invalid_reference /content/term_snapshot_json",
          "term-vocabulary-mismatch": "invalid_reference /content/term_snapshot_json",
          "term-name-snapshot-mismatch": "invalid_reference /content/term_snapshot_json",
          "vocabulary-name-snapshot-mismatch": "invalid_reference /content/term_snapshot_json",
          "retired-term-assignment": "invalid_reference /content/term_snapshot_json",
          "link-absent-session": "invalid_reference /content/link_snapshot_json",
          "link-cross-workspace-trace": "invalid_reference /content/link_snapshot_json",
          "link-cross-workspace-message": "invalid_reference /content/link_snapshot_json",
          "link-mismatched-message-session": "invalid_reference /content/link_snapshot_json",
          "link-absent-node-revision": "invalid_reference /content/link_snapshot_json",
        },
        "absent",
      );

      // Not one of those rejections touched a row, a table version or a count.
      expect(await datasetState(root)).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── assignment policy and cross-field semantics ──────────────────────────────

describe.skipIf(!READY)(`assignment policy and validity [${PENDING}]`, () => {
  test(
    "reserved-type, horizon, cardinality, label and validity rules reject before any append",
    async () => {
      const root = copyFixture("policy-semantics");
      const before = await datasetState(root);

      const cases: PublishCase[] = [
        {
          // Exactly one reserved type assignment is required, so an envelope
          // carrying only a topic term is incomplete even though that term is
          // perfectly valid on its own.
          name: "no-type-assignment",
          workspace: ALPHA,
          node_id: nodeId(30),
          operation_id: "reject-no-type",
          overrides: { term_snapshot_json: termsJson(termEntry(alphaSeed.term_ids.topic.storage!, 0)) },
        },
        {
          // Two ACTIVE type terms exist precisely so this is refutable rather
          // than vacuous: type is cardinality=one and reserved exactly-one.
          name: "two-type-assignments",
          workspace: ALPHA,
          node_id: nodeId(31),
          operation_id: "reject-two-types",
          overrides: {
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0),
              termEntry(alphaSeed.term_ids.type.decision!, 1),
            ),
          },
        },
        {
          // Term has no authoritative label column; Vocabulary.label names a
          // vocabulary. A non-null label on NEW content fabricates provenance.
          name: "nonnull-label-snapshot",
          workspace: ALPHA,
          node_id: nodeId(32),
          operation_id: "reject-label",
          overrides: {
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0, { label_snapshot: "Note" }),
            ),
          },
        },
        {
          name: "inverted-validity-interval",
          workspace: ALPHA,
          node_id: nodeId(33),
          operation_id: "reject-validity-inverted",
          overrides: {
            valid_from: "2026-09-21T00:00:00.000Z",
            valid_to: "2026-09-20T00:00:00.000Z",
          },
        },
        {
          // §5 requires valid_from < valid_to: equal bounds are not an interval.
          name: "equal-validity-bounds",
          workspace: ALPHA,
          node_id: nodeId(34),
          operation_id: "reject-validity-equal",
          overrides: {
            valid_from: "2026-09-20T00:00:00.000Z",
            valid_to: "2026-09-20T00:00:00.000Z",
          },
        },
      ];

      const outcomes = await runCases(root, cases);
      expectOutcomes(
        outcomes,
        {
          "no-type-assignment": "invalid_request /content/term_snapshot_json",
          "two-type-assignments": "invalid_request /content/term_snapshot_json",
          "nonnull-label-snapshot": "invalid_request /content/term_snapshot_json",
          "inverted-validity-interval": "invalid_request /content/valid_from",
          "equal-validity-bounds": "invalid_request /content/valid_from",
        },
        "absent",
      );
      expect(await datasetState(root)).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a required vocabulary must be assigned, independently of the reserved type rule",
    async () => {
      // The seeded policy makes `type` the only required vocabulary, so a
      // missing required assignment and a missing reserved type cannot be told
      // apart. Marking `topic` required on this copy separates them: the type
      // assignment below is present and correct, and only the required rule can
      // reject the first case.
      const root = copyFixture("required-policy");
      await corrupt(root, "update", "vocabularies", { workspace_name: ALPHA, name: "topic" }, { required: true });
      const before = await datasetState(root);

      const outcomes = await runCases(root, [
        {
          name: "required-vocabulary-unassigned",
          workspace: ALPHA,
          node_id: nodeId(35),
          operation_id: "reject-required-missing",
          overrides: { term_snapshot_json: termsJson(termEntry(alphaSeed.term_ids.type.note!, 0)) },
        },
      ]);
      expectOutcomes(
        outcomes,
        { "required-vocabulary-unassigned": "invalid_request /content/term_snapshot_json" },
        "absent",
      );
      expect(await datasetState(root)).toBe(before);

      // Positive control on the same corrupted policy: satisfying the required
      // vocabulary is accepted, so the rejection above is about the missing
      // assignment and not about the policy edit itself.
      const satisfied = await runCases(root, [
        {
          name: "required-vocabulary-assigned",
          workspace: ALPHA,
          node_id: nodeId(36),
          operation_id: "accept-required-satisfied",
          overrides: {
            term_snapshot_json: termsJson(
              termEntry(alphaSeed.term_ids.type.note!, 0),
              termEntry(alphaSeed.term_ids.topic.storage!, 1),
            ),
          },
        },
      ]);
      expectOutcomes(satisfied, { "required-vocabulary-assigned": "accepted accepted" }, "present");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── stored duplicates and malformed policy are integrity failures ────────────

describe.skipIf(!READY)(`stored duplicates and corrupt policy [${PENDING}]`, () => {
  const integrityCase = (slot: number, name: string): PublishCase => ({
    name,
    workspace: ALPHA,
    node_id: nodeId(slot),
    operation_id: `integrity-${name}`,
  });

  test(
    "a duplicate workspace, peer, session, term or vocabulary row fails closed as integrity_failure",
    async () => {
      const duplicates: {
        name: string;
        slot: number;
        table: string;
        match: Record<string, string>;
        overrides: Record<string, unknown>;
        path: string;
      }[] = [
        {
          name: "duplicate-workspace-row",
          slot: 40,
          table: "workspaces",
          match: { name: ALPHA },
          // A second row with the SAME name and a different id: two rows claim
          // one logical identity, which is corruption rather than a tie.
          overrides: { id: "duplicate-workspace-id" },
          path: "/content/workspace_name",
        },
        {
          name: "duplicate-peer-row",
          slot: 41,
          table: "peers",
          match: { workspace_name: ALPHA, name: alphaSeed.peer_names[0] ?? "" },
          overrides: { id: "duplicate-peer-id" },
          path: "/content/author_peer_name",
        },
        {
          name: "duplicate-session-row",
          slot: 42,
          table: "sessions",
          match: { workspace_name: ALPHA, name: alphaSeed.session_name ?? "" },
          overrides: { id: "duplicate-session-id" },
          path: "/content/session_name",
        },
        {
          name: "duplicate-term-row",
          slot: 43,
          table: "terms",
          match: { workspace_name: ALPHA, id: alphaSeed.term_ids?.type?.note?.id ?? "" },
          overrides: { description: "duplicate term row" },
          path: "/content/term_snapshot_json",
        },
        {
          name: "duplicate-vocabulary-row",
          slot: 44,
          table: "vocabularies",
          match: { workspace_name: ALPHA, id: alphaSeed.vocabulary_ids?.type ?? "" },
          overrides: { description: "duplicate vocabulary row" },
          path: "/content/term_snapshot_json",
        },
        {
          // Two vocabularies NAMED type, with distinct ids: the reserved
          // vocabulary is no longer unique even though each row is well formed.
          name: "second-type-vocabulary",
          slot: 45,
          table: "vocabularies",
          match: { workspace_name: ALPHA, name: "type" },
          overrides: { id: "second-type-vocabulary-id" },
          path: "/content/term_snapshot_json",
        },
      ];

      for (const duplicate of duplicates) {
        const root = copyFixture(duplicate.name);
        await corrupt(root, "clone", duplicate.table, duplicate.match, duplicate.overrides);
        const before = await datasetState(root);

        const outcomes = await runCases(root, [integrityCase(duplicate.slot, duplicate.name)]);
        expectOutcomes(
          outcomes,
          { [duplicate.name]: `integrity_failure ${duplicate.path}` },
          "absent",
        );
        // Fail closed and preserve the evidence: corrupt state is not repaired,
        // deduplicated or partially written over.
        expect(await datasetState(root)).toBe(before);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "malformed vocabulary policy columns fail closed as integrity_failure",
    async () => {
      const malformed: { name: string; slot: number; values: Record<string, unknown> }[] = [
        { name: "policy-kind-invalid", slot: 46, values: { kind: "not-a-kind" } },
        { name: "policy-cardinality-invalid", slot: 47, values: { cardinality: "several" } },
      ];

      for (const item of malformed) {
        const root = copyFixture(item.name);
        await corrupt(root, "update", "vocabularies", { workspace_name: ALPHA, name: "type" }, item.values);
        const before = await datasetState(root);

        const outcomes = await runCases(root, [integrityCase(item.slot, item.name)]);
        expectOutcomes(
          outcomes,
          { [item.name]: "integrity_failure /content/term_snapshot_json" },
          "absent",
        );
        expect(await datasetState(root)).toBe(before);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
