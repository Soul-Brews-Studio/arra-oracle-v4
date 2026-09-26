/**
 * #26 evidence: the two ancestry bounds, and persisted ancestry corruption.
 *
 * Contract §4 fixes both bounds and how the byte one is counted: 1024 rows per
 * requested node, and 16 MiB of the compact `revisions` ARRAY — two bracket
 * bytes, each row's JSON bytes, one comma between rows, with the enclosing
 * `{node,snapshot_head_revision_id,revisions}` object excluded. Equality is
 * accepted; only greater-than is rejected. §9 additionally requires the
 * prospective row to be budgeted BEFORE any mutation, and persisted missing,
 * cross-node, cross-workspace, cyclic and digest-corrupt ancestry to fail
 * closed.
 *
 * THE EXPECTED BUDGET IS COMPUTED HERE, NOT IMPORTED.
 * `WIRE_FIELD_ORDER`, `LIMIT_BYTES`, `LIMIT_ROWS` and `chainBytes` below are an
 * independent restatement of the contract text. Nothing in this file asserts a
 * boundary by comparing production output against a production constant — if
 * `MAX_CHAIN_WIRE_BYTES` were changed to 8 MiB, or `revisionWireBytes` stopped
 * counting commas, these tests would fail rather than move with it.
 *
 * PREPARATION VERSUS ASSERTED BEHAVIOUR.
 * A 1024-row chain, a chain weighing exactly 16 MiB, and a cyclic ancestor are
 * all states the kernel deliberately offers no API to produce. They are seeded
 * as disposable fixture state by an owned child that genuinely holds the
 * writer gate, using the protected codec so every seeded row carries a REAL
 * canonical digest — otherwise `decodeVerifiedRevision`'s recompute would have
 * nothing honest to check. What is ASSERTED is only what the kernel does when
 * asked to read or publish against that state.
 *
 * Bounded claim: this is a wire-size bound, not a process-memory sandbox, and
 * the gate remains a cooperative operator protocol.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOp } from "../../../src/contracts/revision-v1";
import { openPublicationReader } from "../../../src/publication/service";
import {
  createFixture,
  encodeRequest,
  revisionEnvelope,
  runGated,
  type Fixture,
  type SeededWorkspace,
} from "../../helpers/publication-fixture";
import { scaledMs } from "../../helpers/timing.scaledMs";
import { testTimeout } from "../../helpers/timing.testTimeout";

const CHILD = new URL("./limits-integrity-child.ts", import.meta.url).pathname;
const SEED_DEADLINE_MS = scaledMs(300_000);
const TEST_TIMEOUT_MS = testTimeout(600_000);

/** Contract §4, restated independently of `rows.ts`. */
const LIMIT_BYTES = 16 * 1024 * 1024;
const LIMIT_ROWS = 1024;

/**
 * The 26 physical NodeRevision columns in target schema order.
 *
 * Transcribed from `target_v1/knowledge.py`, deliberately NOT imported from
 * `publication/rows.ts`: a reordering there must show up here as a failure,
 * not be silently adopted by the expectation.
 */
const WIRE_FIELD_ORDER = [
  "id", "workspace_name", "node_id", "revision_no", "base_revision_id", "operation_id",
  "title", "body", "body_format", "fields",
  "author_peer_name", "observer_peer_name", "subject_peer_name", "session_name",
  "is_active", "valid_from", "valid_to", "change_reason", "created_at",
  "schema_version", "canonical_version", "content_digest",
  "term_snapshot_json", "link_snapshot_json", "h_metadata", "internal_metadata",
] as const;

/**
 * Every content digest is 64 lowercase hex characters, so its VALUE cannot
 * change the wire length. Counting with a placeholder keeps the byte oracle
 * independent of what the codec actually digested.
 */
const DIGEST_PLACEHOLDER = "0".repeat(64);
const SEED_INSTANT = "2026-09-20T00:00:00.000Z";

const utf8 = (text: string): number => new TextEncoder().encode(text).byteLength;

/** One row's compact JSON byte length, fields emitted in schema order. */
function rowBytes(wire: Record<string, unknown>): number {
  const ordered: Record<string, unknown> = {};
  for (const field of WIRE_FIELD_ORDER) ordered[field] = wire[field] ?? null;
  return utf8(JSON.stringify(ordered));
}

/** `[]` is 2 bytes; each row adds its JSON, each row after the first a comma. */
function chainBytes(rows: Record<string, unknown>[]): number {
  let total = 2;
  for (let i = 0; i < rows.length; i++) total += rowBytes(rows[i]!) + (i > 0 ? 1 : 0);
  return total;
}

/** A 21-character identifier in the governed nanoid grammar. */
function id21(prefix: string, n: number): string {
  const digits = String(n).padStart(6, "0");
  const filler = "_".repeat(Math.max(0, 21 - prefix.length - digits.length));
  return `${prefix}${filler}${digits}`.slice(0, 21);
}

type RowPlan = {
  wire: Record<string, unknown>;
  /** What the child is told to write: a pad COUNT, never a 16 MiB string. */
  seed: Record<string, unknown>;
  /** Exact wire bytes once the padding is expanded. */
  bytes: number;
};

/**
 * Build one revision row, as both an expectation and a seed instruction.
 *
 * The body is one byte plus `bodyPad` copies of `a`. `a` is a single UTF-8
 * byte that `JSON.stringify` never escapes, so padding is exactly linear in
 * wire bytes — which is what lets a 16 MiB expectation be computed without
 * materialising 16 MiB of strings.
 */
function planRow(args: {
  workspace: string;
  seeded: SeededWorkspace;
  nodeId: string;
  revisionId: string;
  revisionNo: number;
  baseRevisionId: string | null;
  operationId: string;
  bodyPad: number;
}): RowPlan {
  const envelope = revisionEnvelope(args.workspace, args.seeded, args.nodeId, {
    base_revision_id: args.baseRevisionId,
    body: "b",
  });
  // The protected codec owns normalisation, so the expectation is built from
  // the columns that will actually be persisted, not from the raw request
  // strings. Preparation may use the codec; the BUDGET arithmetic may not.
  const validated = revisionOp(new Map(Object.entries(envelope)) as never, []);
  const columns = validated.columns as unknown as Record<string, string | null>;

  const wire: Record<string, unknown> = {
    ...envelope,
    id: args.revisionId,
    revision_no: String(args.revisionNo),
    operation_id: args.operationId,
    created_at: SEED_INSTANT,
    content_digest: DIGEST_PLACEHOLDER,
    fields: columns.fields,
    term_snapshot_json: columns.term_snapshot_json,
    link_snapshot_json: columns.link_snapshot_json,
    h_metadata: columns.h_metadata,
    internal_metadata: columns.internal_metadata,
  };

  const seed = { ...wire, body: "b", body_pad: args.bodyPad };
  delete (seed as Record<string, unknown>).content_digest; // the child computes the real one
  return { wire, seed, bytes: rowBytes(wire) + args.bodyPad };
}

/** A whole chain: revision i+1 bases on revision i, oldest first. */
function planChain(args: {
  workspace: string;
  seeded: SeededWorkspace;
  nodeId: string;
  prefix: string;
  count: number;
  bodyPad?: (index: number) => number;
}): RowPlan[] {
  const rows: RowPlan[] = [];
  for (let i = 0; i < args.count; i++) {
    rows.push(
      planRow({
        workspace: args.workspace,
        seeded: args.seeded,
        nodeId: args.nodeId,
        revisionId: id21(args.prefix, i + 1),
        revisionNo: i + 1,
        baseRevisionId: i === 0 ? null : id21(args.prefix, i),
        operationId: id21(`${args.prefix}op`, i + 1),
        bodyPad: args.bodyPad?.(i) ?? 0,
      }),
    );
  }
  return rows;
}

const totalBytes = (rows: RowPlan[]): number =>
  2 + rows.reduce((sum, row, i) => sum + row.bytes + (i > 0 ? 1 : 0), 0);

function nodeRow(workspace: string, nodeId: string, headId: string): Record<string, unknown> {
  return {
    id: nodeId,
    workspace_name: workspace,
    current_revision_id: headId,
    created_at: SEED_INSTANT,
    updated_at: SEED_INSTANT,
  };
}

type ChildResult = { results: Record<string, unknown>[] };

/** Run the owned gated child once with a plan. The helper owns the deadline. */
async function runPlan(fixture: Fixture, steps: unknown[]): Promise<ChildResult> {
  const dir = await mkdtemp(join(tmpdir(), "arra-pub26-plan-"));
  const planPath = join(dir, "plan.json");
  try {
    await writeFile(planPath, JSON.stringify({ datasetRoot: fixture.datasetRoot, steps }), "utf8");
    const run = await runGated(fixture.datasetRoot, CHILD, [planPath], {
      deadlineMs: SEED_DEADLINE_MS,
    });
    if (run.code !== 0) {
      throw new Error(`gated child failed (${run.code}): ${run.stderr.slice(0, 1200)}`);
    }
    return JSON.parse(run.stdout) as ChildResult;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const seedSteps = (rows: RowPlan[], workspace: string, nodeId: string, headId: string) => [
  { op: "seedRevisions", rows: rows.map((row) => row.seed) },
  { op: "seedNode", node: nodeRow(workspace, nodeId, headId) },
];

const readRequest = (workspace: string, nodeId: string) =>
  encodeRequest({ workspace_name: workspace, node_id: nodeId });

/** Assert a publication rejection by CODE, without swallowing a missing one. */
async function expectPublicationError(promise: Promise<unknown>, code: string): Promise<void> {
  const marker = Symbol("no-rejection");
  let thrown: unknown = marker;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  if (thrown === marker) throw new Error(`expected a ${code} rejection, got a resolved value`);
  expect((thrown as { code?: string }).code).toBe(code);
  expect((thrown as { toJSON?: () => { version: string } }).toJSON?.().version).toBe(
    "arra-publication-error/v1",
  );
}

const findResult = (child: ChildResult, op: string, occurrence = 0) =>
  child.results.filter((entry) => entry.op === op)[occurrence] as Record<string, unknown>;

describe("publication ancestry bounds", () => {
  test(
    "1024 rows read, a 1025th refused before append, a 1025-row chain unreadable",
    async () => {
      const fixture = await createFixture();
      try {
        const workspace = "alpha-workspace";
        const seeded = fixture.workspaces[workspace]!;
        const nodeId = id21("nrows", 1);
        const rows = planChain({ workspace, seeded, nodeId, prefix: "rrow", count: LIMIT_ROWS });

        // This case must isolate the ROW bound: prove the same chain is
        // nowhere near the byte bound, so a failure cannot be the other rule.
        expect(totalBytes(rows)).toBeLessThan(LIMIT_BYTES);

        await runPlan(fixture, seedSteps(rows, workspace, nodeId, id21("rrow", LIMIT_ROWS)));

        const reader = await openPublicationReader(fixture.datasetRoot);
        const history = (await reader.listAcceptedHistory(readRequest(workspace, nodeId))) as {
          revisions: Record<string, unknown>[];
          snapshot_head_revision_id: string;
        };
        expect(history.revisions.length).toBe(LIMIT_ROWS);
        expect(history.snapshot_head_revision_id).toBe(id21("rrow", LIMIT_ROWS));
        // Oldest first, ordinals exactly 1..1024.
        expect(history.revisions[0]!.revision_no).toBe("1");
        expect(history.revisions.at(-1)!.revision_no).toBe(String(LIMIT_ROWS));
        // The served rows weigh what this file independently says they weigh.
        expect(chainBytes(history.revisions)).toBe(totalBytes(rows));

        // A 1025th publication is refused, and refused BEFORE it mutates.
        const child = await runPlan(fixture, [
          { op: "snapshot" },
          {
            op: "publish",
            revisionId: id21("rrow", LIMIT_ROWS + 1),
            createdAtMs: Date.parse(SEED_INSTANT),
            envelope: {
              operation_id: id21("rrowop", LIMIT_ROWS + 1),
              content: revisionEnvelope(workspace, seeded, nodeId, {
                base_revision_id: id21("rrow", LIMIT_ROWS),
                body: "b",
              }),
            },
          },
          { op: "snapshot" },
        ]);
        const publish = findResult(child, "publish");
        expect(publish.ok).toBe(false);
        expect((publish.error as { code: string }).code).toBe("limit_exceeded");
        expect((publish.error as { version: string }).version).toBe("arra-publication-error/v1");
        // Unchanged rows AND unchanged table version: a refusal that bumped the
        // version would mean something was written and then not counted.
        expect(findResult(child, "snapshot", 1).snapshot).toEqual(
          findResult(child, "snapshot", 0).snapshot as never,
        );

        // Now put a 1025-row chain on disk directly. Reading it must fail
        // closed rather than silently truncate to 1024.
        const extra = planRow({
          workspace,
          seeded,
          nodeId,
          revisionId: id21("rrow", LIMIT_ROWS + 1),
          revisionNo: LIMIT_ROWS + 1,
          baseRevisionId: id21("rrow", LIMIT_ROWS),
          operationId: id21("rrowop", LIMIT_ROWS + 1),
          bodyPad: 0,
        });
        await runPlan(fixture, [
          { op: "seedRevisions", rows: [extra.seed] },
          {
            op: "rawUpdate",
            table: "nodes",
            predicate: `workspace_name = '${workspace}' AND id = '${nodeId}'`,
            assignments: { current_revision_id: `'${id21("rrow", LIMIT_ROWS + 1)}'` },
          },
        ]);

        const after = await openPublicationReader(fixture.datasetRoot);
        await expectPublicationError(
          after.listAcceptedHistory(readRequest(workspace, nodeId)),
          "limit_exceeded",
        );
        await expectPublicationError(
          after.getAcceptedHead(readRequest(workspace, nodeId)),
          "limit_exceeded",
        );
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "exactly 16 MiB is served, 16 MiB + 1 byte is refused",
    async () => {
      const fixture = await createFixture();
      try {
        const workspace = "alpha-workspace";
        const seeded = fixture.workspaces[workspace]!;
        const count = 512;

        // Solve for the padding that lands the chain exactly on the limit.
        const shape = (nodeId: string, prefix: string, extra: number) => {
          const bare = planChain({ workspace, seeded, nodeId, prefix, count });
          const deficit = LIMIT_BYTES - totalBytes(bare);
          const per = Math.floor(deficit / count);
          const remainder = deficit - per * count + extra;
          return planChain({
            workspace,
            seeded,
            nodeId,
            prefix,
            count,
            bodyPad: (i) => per + (i === count - 1 ? remainder : 0),
          });
        };

        const exactNode = id21("nexact", 1);
        const overNode = id21("nover", 1);
        const exact = shape(exactNode, "rexa", 0);
        const over = shape(overNode, "rovr", 1);

        // The expectations are arithmetic this file did itself.
        expect(totalBytes(exact)).toBe(LIMIT_BYTES);
        expect(totalBytes(over)).toBe(LIMIT_BYTES + 1);

        await runPlan(fixture, [
          ...seedSteps(exact, workspace, exactNode, id21("rexa", count)),
          ...seedSteps(over, workspace, overNode, id21("rovr", count)),
        ]);

        const reader = await openPublicationReader(fixture.datasetRoot);
        const history = (await reader.listAcceptedHistory(readRequest(workspace, exactNode))) as {
          revisions: Record<string, unknown>[];
        };
        expect(history.revisions.length).toBe(count);
        // Equality is ACCEPTED: the served array is exactly the limit.
        expect(chainBytes(history.revisions)).toBe(LIMIT_BYTES);

        await expectPublicationError(
          reader.listAcceptedHistory(readRequest(workspace, overNode)),
          "limit_exceeded",
        );
        await expectPublicationError(
          reader.getAcceptedHead(readRequest(workspace, overNode)),
          "limit_exceeded",
        );
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a prospective append is budgeted before any mutation",
    async () => {
      const fixture = await createFixture();
      try {
        const workspace = "alpha-workspace";
        const seeded = fixture.workspaces[workspace]!;
        const nodeId = id21("nprop", 1);
        const count = 512;
        const nextPad = 4096;

        // The row the kernel WILL build, predicted exactly: every input to it
        // is chosen here -- revision id, operation id, clock, ordinal and base.
        const nextRow = planRow({
          workspace,
          seeded,
          nodeId,
          revisionId: id21("rpro", count + 1),
          revisionNo: count + 1,
          baseRevisionId: id21("rpro", count),
          operationId: id21("rproop", count + 1),
          bodyPad: nextPad,
        });

        // Leave room for that row and its comma, and not one byte more.
        const target = LIMIT_BYTES - nextRow.bytes - 1;
        const bare = planChain({ workspace, seeded, nodeId, prefix: "rpro", count });
        const deficit = target - totalBytes(bare);
        const per = Math.floor(deficit / count);
        const rows = planChain({
          workspace,
          seeded,
          nodeId,
          prefix: "rpro",
          count,
          bodyPad: (i) => per + (i === count - 1 ? deficit - per * count : 0),
        });
        expect(totalBytes(rows)).toBe(target);

        await runPlan(fixture, seedSteps(rows, workspace, nodeId, id21("rpro", count)));

        const publishStep = (pad: number, suffix: number) => ({
          op: "publish",
          revisionId: id21("rpro", count + 1),
          createdAtMs: Date.parse(SEED_INSTANT),
          bodyPad: pad,
          envelope: {
            operation_id: id21("rproop", count + suffix),
            content: revisionEnvelope(workspace, seeded, nodeId, {
              base_revision_id: id21("rpro", count),
              body: "b",
            }),
          },
        });

        // One byte over first, from the UNMUTATED pre-state: refused, and the
        // dataset must be untouched. Then exactly the limit from that same
        // pre-state: accepted. Same starting point, one byte apart.
        //
        // Two gated runs rather than one, because a writer can be opened ONCE
        // per gated process: `close()` releases the inherited fd 42, which is
        // the descriptor holding the flock, so the same process cannot take
        // the gate again afterwards. Splitting also makes the pre-state
        // identical for both attempts by construction.
        const rejectRun = await runPlan(fixture, [
          { op: "snapshot" },
          publishStep(nextPad + 1, 2),
          { op: "snapshot" },
        ]);

        const refused = findResult(rejectRun, "publish", 0);
        expect(refused.ok).toBe(false);
        expect((refused.error as { code: string }).code).toBe("limit_exceeded");
        expect(findResult(rejectRun, "snapshot", 1).snapshot).toEqual(
          findResult(rejectRun, "snapshot", 0).snapshot as never,
        );

        const acceptRun = await runPlan(fixture, [publishStep(nextPad, 1)]);
        const accepted = findResult(acceptRun, "publish", 0);
        expect(accepted.ok).toBe(true);
        expect((accepted.outcome as { outcome: string }).outcome).toBe("accepted");
        expect((accepted.outcome as { revision_no: string }).revision_no).toBe(String(count + 1));

        const reader = await openPublicationReader(fixture.datasetRoot);
        const history = (await reader.listAcceptedHistory(readRequest(workspace, nodeId))) as {
          revisions: Record<string, unknown>[];
        };
        expect(history.revisions.length).toBe(count + 1);
        // The accepted chain sits exactly on the limit, by this file's count.
        expect(chainBytes(history.revisions)).toBe(LIMIT_BYTES);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("persisted ancestry integrity", () => {
  test(
    "missing, cross-node, cross-workspace, cyclic and digest-corrupt chains all fail closed",
    async () => {
      const fixture = await createFixture();
      try {
        const workspace = "alpha-workspace";
        const other = "beta-workspace";
        const seeded = fixture.workspaces[workspace]!;
        const otherSeeded = fixture.workspaces[other]!;

        const healthyNode = id21("nok", 1);
        const missingNode = id21("nmiss", 1);
        const crossNode = id21("ncross", 1);
        const foreignNode = id21("nforeign", 1);
        const cycleNode = id21("ncycle", 1);
        const digestNode = id21("ndigest", 1);
        const otherNode = id21("nother", 1);

        const healthy = planChain({ workspace, seeded, nodeId: healthyNode, prefix: "rok", count: 3 });

        // MISSING ANCESTOR: revisions 1 and 3 exist, 2 never does. Seeded that
        // way rather than patched afterwards, so every stored digest stays
        // valid and the ONLY defect is the absent ancestor.
        const missing = planChain({
          workspace, seeded, nodeId: missingNode, prefix: "rmis", count: 3,
        }).filter((_, index) => index !== 1);

        // CROSS-NODE: the head bases on a revision that belongs to another node.
        const crossOwn = planRow({
          workspace, seeded, nodeId: crossNode,
          revisionId: id21("rcrs", 2), revisionNo: 2,
          baseRevisionId: id21("rok", 1), operationId: id21("rcrsop", 2), bodyPad: 0,
        });

        // CROSS-WORKSPACE: the head bases on an id that exists only in the
        // other workspace. The scoped lookup never leaves this workspace, so
        // the observable result is refusal -- and the foreign row stays intact.
        const foreignChain = planChain({
          workspace: other, seeded: otherSeeded, nodeId: otherNode, prefix: "roth", count: 1,
        });
        const foreignRef = planRow({
          workspace, seeded, nodeId: foreignNode,
          revisionId: id21("rfor", 2), revisionNo: 2,
          baseRevisionId: id21("roth", 1), operationId: id21("rforop", 2), bodyPad: 0,
        });

        // CYCLE: each row bases on the other. Both digests are honest; the
        // chain simply never terminates.
        const cycleA = planRow({
          workspace, seeded, nodeId: cycleNode,
          revisionId: id21("rcyc", 1), revisionNo: 1,
          baseRevisionId: id21("rcyc", 2), operationId: id21("rcycop", 1), bodyPad: 0,
        });
        const cycleB = planRow({
          workspace, seeded, nodeId: cycleNode,
          revisionId: id21("rcyc", 2), revisionNo: 2,
          baseRevisionId: id21("rcyc", 1), operationId: id21("rcycop", 2), bodyPad: 0,
        });

        // DIGEST CORRUPTION: a valid chain, then the head's stored body is
        // edited in place. This is a real persisted row whose recomputed digest
        // no longer matches -- not a hand-built descriptor.
        const digest = planChain({
          workspace, seeded, nodeId: digestNode, prefix: "rdig", count: 2,
        });

        await runPlan(fixture, [
          ...seedSteps(healthy, workspace, healthyNode, id21("rok", 3)),
          { op: "seedRevisions", rows: missing.map((row) => row.seed) },
          { op: "seedNode", node: nodeRow(workspace, missingNode, id21("rmis", 3)) },
          { op: "seedRevisions", rows: [crossOwn.seed] },
          { op: "seedNode", node: nodeRow(workspace, crossNode, id21("rcrs", 2)) },
          ...seedSteps(foreignChain, other, otherNode, id21("roth", 1)),
          { op: "seedRevisions", rows: [foreignRef.seed] },
          { op: "seedNode", node: nodeRow(workspace, foreignNode, id21("rfor", 2)) },
          { op: "seedRevisions", rows: [cycleA.seed, cycleB.seed] },
          { op: "seedNode", node: nodeRow(workspace, cycleNode, id21("rcyc", 2)) },
          ...seedSteps(digest, workspace, digestNode, id21("rdig", 2)),
          {
            op: "rawUpdate",
            table: "node_revisions",
            predicate: `workspace_name = '${workspace}' AND id = '${id21("rdig", 2)}'`,
            assignments: { body: "'tampered after the digest was computed'" },
          },
        ]);

        const reader = await openPublicationReader(fixture.datasetRoot);

        // The control: a healthy chain in the SAME dataset still reads, so the
        // failures below are about the corruption and not a broken fixture.
        const ok = (await reader.listAcceptedHistory(readRequest(workspace, healthyNode))) as {
          revisions: Record<string, unknown>[];
        };
        expect(ok.revisions.length).toBe(3);

        for (const [label, node] of [
          ["missing ancestor", missingNode],
          ["cross-node base", crossNode],
          ["cross-workspace base", foreignNode],
          ["cyclic chain", cycleNode],
          ["digest-corrupt head", digestNode],
        ] as const) {
          await expectPublicationError(
            reader.listAcceptedHistory(readRequest(workspace, node)),
            "integrity_failure",
          );
          await expectPublicationError(
            reader.getAcceptedHead(readRequest(workspace, node)),
            "integrity_failure",
          );
          expect(label.length).toBeGreaterThan(0); // keeps the label in the failure output
        }

        // The other workspace's row was never touched by any of this.
        const foreignHistory = (await reader.listAcceptedHistory(readRequest(other, otherNode))) as {
          revisions: Record<string, unknown>[];
        };
        expect(foreignHistory.revisions.length).toBe(1);
        expect(foreignHistory.revisions[0]!.workspace_name).toBe(other);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
