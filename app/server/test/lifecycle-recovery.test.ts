// #29 lifecycle recovery — lost ACK, fail-stop and real SDK failures, plus
// the lifecycle-specific properties LC-1 and LC-2 exercised across a REAL
// process kill rather than a thrown boundary hook. Refs #29, Parent #28.
//
// Shape copied from the accepted `read-cursor-recovery.test.ts` (#73): real
// gated children only, killed by exact PID, an instrumented raw-storage
// interleave planted INSIDE the same process that already holds the writer
// gate (never a second writer, never a store mock), and durable evidence
// read back through a gateless raw connection after the owner is gone.
//
// What this file proves, per the lifecycle kernel (`service.ts:3540-3785`,
// `lifecycle.ts`):
//
// * R1 — a kill AFTER the supersede_log append but BEFORE the ACK: the row is
//   durable, a fresh owner sees it, and a retry on the same
//   (workspace_name, operation_id) returns the RETAINED event — no second
//   row, no clock sample — even after the successor's own head has since
//   moved (LC-1, under a real crash rather than a thrown hook).
// * R2 — a kill BEFORE the write (before_write) leaves no row at all, and the
//   int64 allocator hands the FIRST id to the next attempt, not a skipped
//   ordinal reserved for the aborted one.
// * R3 — a commanded boundary failure BEFORE any write throws invalid_request
//   and leaves the owner usable; the SAME failure AFTER a write poisons
//   (recovery_required).
// * R4 — a REAL SDK failure (a locked table directory, not a thrown hook)
//   surfaces recovery_required; a genuinely safe governed error raised at
//   readback (a planted duplicate operation_id row, forcing the store's own
//   uniqueness check to fire) keeps its OWN class (integrity_failure) rather
//   than being normalized, while the owner is still poisoned afterwards.
// * R5 — supersede vs retire is distinguishable ONLY by new_id/new_revision_id
//   null-ness (no event-kind column); a planted half-null pair is
//   integrity_failure the moment anything reads it back.
// * R6 — LC-2 under a real crash: an orphan revision (killed after the
//   revision row lands, before the head moves) cannot resume onto a node
//   retired in the meantime, while a DIFFERENT, already-ACKed publish from
//   before the retirement still replays idempotent, and a genuinely NEW
//   revision on the retired node is refused.
//
// Bounded claims: process death and SDK-reported failure on local Darwin with
// pinned Bun and Python. The gate stays a cooperative operator protocol; this
// is not evidence about power loss, NFS or multiwriter CAS.
//
// Ownership: this file and `test/fixtures/lifecycle-v1/recovery/**` only.

import { afterAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { connect } from "@lancedb/lancedb";
import { createFixture, revisionEnvelope, runGated, spawnGatedChild, type Fixture } from "./helpers/publication-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OPS_CHILD = join(TEST_DIR, "fixtures", "lifecycle-v1", "core", "gated-lifecycle.ts");
const RECOVERY_CHILD = join(TEST_DIR, "fixtures", "lifecycle-v1", "recovery", "lifecycle-child.ts");
const TEST_TIMEOUT_MS = testTimeout(180_000);
const ALPHA = "alpha-workspace";
const KILL_DEADLINE_MS = scaledMs(60_000);

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const cleanups: { label: string; run: () => Promise<void> }[] = [];
async function freshFixture(label: string): Promise<Fixture> {
  const fixture = await createFixture([ALPHA]);
  cleanups.push({ label, run: fixture.cleanup });
  return fixture;
}
afterAll(async () => {
  const failures: string[] = [];
  for (const { label, run } of cleanups) {
    await run().catch((error: unknown) => failures.push(`${label}: ${String(error)}`));
  }
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

// ── ops child: an ordinary, complete, single-shot gated run ─────────────────

const pub = (facadeMethod: string, request: unknown) => ({ facade: "publication", method: facadeMethod, request });
const ctx = (facadeMethod: string, request: unknown) => ({ facade: "context", method: facadeMethod, request });

async function runOps(
  fixture: Fixture,
  ops: Array<Record<string, unknown>>,
  revisionIds: string[],
  clockMs: number | number[] = 1_789_000_000_000,
): Promise<Record<string, any>> {
  const result = await runGated(fixture.datasetRoot, OPS_CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, revisionIds, clockMs }),
  ]);
  if (result.code !== 0) throw new Error(`ops child exited ${result.code}: ${result.stderr.slice(0, 800)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 800)}`);
  return JSON.parse(line);
}

// ── recovery child: a streaming gated run the parent can kill mid-flight ────

type Event = Record<string, any>;

function spawnRecovery(root: string, payload: Record<string, unknown>) {
  return spawnGatedChild(root, RECOVERY_CHILD, [root, JSON.stringify(payload)]);
}

async function readEvent(owner: ReturnType<typeof spawnGatedChild>): Promise<Event> {
  const line = await owner.nextLine(KILL_DEADLINE_MS);
  return JSON.parse(line) as Event;
}

/** Drain events until `predicate` matches one, collecting everything seen
 *  (including every "result" along the way) so a caller can assert on
 *  absence — e.g. "no result for index 0 before the kill". */
async function drainUntil(
  owner: ReturnType<typeof spawnGatedChild>,
  predicate: (event: Event) => boolean,
): Promise<{ matched: Event; seen: Event[] }> {
  const seen: Event[] = [];
  for (;;) {
    const event = await readEvent(owner);
    seen.push(event);
    if (predicate(event)) return { matched: event, seen };
  }
}

async function killAndReap(owner: ReturnType<typeof spawnGatedChild>): Promise<void> {
  owner.kill();
  await owner.wait(KILL_DEADLINE_MS).catch(() => undefined);
}

/** Run a recovery child to completion (no kill), returning every event. */
async function runToCompletion(root: string, payload: Record<string, unknown>): Promise<Event[]> {
  const owner = spawnRecovery(root, payload);
  try {
    const { seen } = await drainUntil(owner, (e) => e.event === "done");
    return seen;
  } finally {
    await killAndReap(owner);
  }
}

const resultOf = (events: Event[], index: number): Event => {
  const event = events.find((e) => e.event === "result" && e.index === index);
  if (event === undefined) throw new Error(`no result at index ${index}; saw ${JSON.stringify(events)}`);
  return event;
};
const clockCallsOf = (events: Event[]): number => events.find((e) => e.event === "clockCalls")?.n as number;

// ── durable evidence, read back with NO gate held ────────────────────────────

async function rawSupersedeLogRows(root: string): Promise<Record<string, unknown>[]> {
  const db = await connect(root, { readConsistencyInterval: 0 });
  const table = await db.openTable("supersede_log");
  await table.checkoutLatest();
  const arrow = await table.query().toArrow();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < arrow.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const field of arrow.schema.fields) {
      const column = arrow.getChild(field.name)!;
      const value = column.get(i);
      row[field.name] = typeof value === "bigint" ? value.toString(10) : value;
    }
    rows.push(row);
  }
  return rows;
}

// ── R1: lost ACK, fresh owner recovers, replay stays retained under LC-1 ────

describe("R1: lost ACK on the lifecycle write path, and LC-1 under a real crash", () => {
  test(
    "a supersede killed after its append but before the ACK is durable; a fresh owner's byte-identical retry returns the RETAINED event — no second row, no clock sample — even after the successor's head moved",
    async () => {
      const NODE_E = idOf("r1nodeE");
      const NODE_F = idOf("r1nodeF");
      const REV_E1 = idOf("r1revE1");
      const REV_F1 = idOf("r1revF1");
      const REV_F2 = idOf("r1revF2");
      const OP_ID = "op-r1-supersede";

      const fixture = await freshFixture("r1");
      const alpha = fixture.workspaces[ALPHA]!;

      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r1-e1", content: revisionEnvelope(ALPHA, alpha, NODE_E) }),
         pub("publishRevision", { operation_id: "op-r1-f1", content: revisionEnvelope(ALPHA, alpha, NODE_F) })],
        [REV_E1, REV_F1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");
      expect(seeded.op1.value.outcome).toBe("accepted");

      const supersedeRequest = {
        workspace_name: ALPHA,
        node_id: NODE_E,
        expected_revision_id: REV_E1,
        new_node_id: NODE_F,
        new_revision_id: REV_F1,
        reason: "R1 lost-ack probe",
        peer_name: null,
        operation_id: OP_ID,
      };

      // Kill AFTER the append (after_write) but BEFORE the ACK ever forms.
      const crashed = spawnRecovery(fixture.datasetRoot, {
        ops: [ctx("supersedeNode", supersedeRequest)],
        clockMs: 1_790_000_000_000,
        contextParkAt: { name: "after_write", occurrence: 1 },
      });
      let crashSeen: Event[];
      try {
        const drained = await drainUntil(crashed, (e) => e.event === "parked");
        crashSeen = drained.seen;
      } finally {
        await killAndReap(crashed);
      }
      // No ACK ever arrived: the child died before emitting a result.
      expect(crashSeen.some((e) => e.event === "result")).toBe(false);

      // Durable evidence, read with no gate held: the row IS on disk.
      const afterCrash = await rawSupersedeLogRows(fixture.datasetRoot);
      expect(afterCrash).toHaveLength(1);
      expect(afterCrash[0]?.id).toBe("1");
      expect(afterCrash[0]?.old_id).toBe(NODE_E);
      expect(afterCrash[0]?.new_id).toBe(NODE_F);
      expect(afterCrash[0]?.operation_id).toBe(OP_ID);

      // A fresh owner sees it immediately via getRecallEligibility.
      const seenByFresh = await runToCompletion(fixture.datasetRoot, {
        ops: [ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_E })],
      });
      expect(resultOf(seenByFresh, 0)).toMatchObject({ ok: true, value: { eligible: false, witness_event_id: "1" } });

      // LC-1: the successor's head moves AFTER the crash, BEFORE the replay.
      const moved = await runOps(
        fixture,
        [pub("publishRevision", {
          operation_id: "op-r1-f2",
          content: revisionEnvelope(ALPHA, alpha, NODE_F, { base_revision_id: REV_F1, title: "moved title" }),
        })],
        [REV_F2],
      );
      expect(moved.op0.value.outcome).toBe("accepted");

      // The byte-identical retry, on a THIRD fresh owner.
      const retried = await runToCompletion(fixture.datasetRoot, { ops: [ctx("supersedeNode", supersedeRequest)] });
      const replay = resultOf(retried, 0);
      expect(replay.ok).toBe(true);
      expect(replay.value.outcome).toBe("idempotent");
      expect(replay.value.row.id).toBe("1");
      // Still pins the ORIGINAL successor revision, not the one that moved.
      expect(replay.value.row.new_revision_id).toBe(REV_F1);
      // No clock sample and no second row on the replay.
      expect(clockCallsOf(retried)).toBe(0);
      const afterReplay = await rawSupersedeLogRows(fixture.datasetRoot);
      expect(afterReplay).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── R2: a pre-write kill leaves no row, and the allocator skips nothing ─────

describe("R2: a kill BEFORE the write leaves no row, and the allocator hands out the FIRST id, not a skipped one", () => {
  test(
    "retireNode killed at before_write leaves zero rows; the next real attempt gets id 1, not 2",
    async () => {
      const NODE_H = idOf("r2nodeH");
      const REV_H1 = idOf("r2revH1");
      const fixture = await freshFixture("r2");
      const alpha = fixture.workspaces[ALPHA]!;

      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r2-h1", content: revisionEnvelope(ALPHA, alpha, NODE_H) })],
        [REV_H1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");

      const crashed = spawnRecovery(fixture.datasetRoot, {
        ops: [ctx("retireNode", {
          workspace_name: ALPHA,
          node_id: NODE_H,
          expected_revision_id: REV_H1,
          reason: "R2 pre-write kill",
          peer_name: null,
          operation_id: "op-r2-retire-crashed",
        })],
        clockMs: 1_790_100_000_000,
        contextParkAt: { name: "before_write", occurrence: 1 },
      });
      let crashSeen: Event[];
      try {
        const drained = await drainUntil(crashed, (e) => e.event === "parked");
        crashSeen = drained.seen;
      } finally {
        await killAndReap(crashed);
      }
      expect(crashSeen.some((e) => e.event === "result")).toBe(false);

      // Nothing was ever appended.
      expect(await rawSupersedeLogRows(fixture.datasetRoot)).toEqual([]);

      // The next attempt (a genuinely new operation_id, not a replay) gets
      // the FIRST id — the aborted attempt reserved nothing.
      const retried = await runToCompletion(fixture.datasetRoot, {
        ops: [ctx("retireNode", {
          workspace_name: ALPHA,
          node_id: NODE_H,
          expected_revision_id: REV_H1,
          reason: "R2 retry",
          peer_name: null,
          operation_id: "op-r2-retire-retry",
        })],
      });
      const retire = resultOf(retried, 0);
      expect(retire.ok).toBe(true);
      expect(retire.value.outcome).toBe("accepted");
      expect(retire.value.row.id).toBe("1");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── R3: pre-write refusal is usable; post-write refusal poisons ────────────

describe("R3: a commanded boundary failure BEFORE any write leaves the owner usable; the SAME failure AFTER a write poisons", () => {
  test(
    "throwing at before_write yields invalid_request and the owner stays usable",
    async () => {
      const NODE_I = idOf("r3nodeI");
      const REV_I1 = idOf("r3revI1");
      const fixture = await freshFixture("r3-before");
      const alpha = fixture.workspaces[ALPHA]!;
      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r3b-i1", content: revisionEnvelope(ALPHA, alpha, NODE_I) })],
        [REV_I1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");

      const events = await runToCompletion(fixture.datasetRoot, {
        ops: [
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_I,
            expected_revision_id: REV_I1,
            reason: "R3 before-write throw",
            peer_name: null,
            operation_id: "op-r3-before",
          }),
          // A genuine WRITE retry, not a read: this is the real proof the
          // queue itself was never poisoned by the pre-write refusal.
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_I,
            expected_revision_id: REV_I1,
            reason: "R3 before-write throw, retried",
            peer_name: null,
            operation_id: "op-r3-before-retry",
          }),
        ],
        contextThrowAt: { name: "before_write", occurrence: 1 },
      });

      const thrown = resultOf(events, 0);
      expect(thrown.ok).toBe(false);
      expect(thrown.error.code).toBe("invalid_request");

      // The owner is still usable: nothing was attempted, so no poison, and
      // the retry on the SAME owner is genuinely accepted.
      const usable = resultOf(events, 1);
      expect(usable.ok).toBe(true);
      expect(usable.value.outcome).toBe("accepted");

      // Exactly the retry's row landed; the thrown attempt left nothing.
      const rows = await rawSupersedeLogRows(fixture.datasetRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.operation_id).toBe("op-r3-before-retry");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "throwing at after_write yields recovery_required and poisons the owner",
    async () => {
      const NODE_J = idOf("r3nodeJ");
      const REV_J1 = idOf("r3revJ1");
      const fixture = await freshFixture("r3-after");
      const alpha = fixture.workspaces[ALPHA]!;
      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r3a-j1", content: revisionEnvelope(ALPHA, alpha, NODE_J) })],
        [REV_J1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");

      const events = await runToCompletion(fixture.datasetRoot, {
        ops: [
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_J,
            expected_revision_id: REV_J1,
            reason: "R3 after-write throw",
            peer_name: null,
            operation_id: "op-r3-after",
          }),
          // A READ (getRecallEligibility) deliberately is NOT used here: reads
          // bypass the write queue entirely and survive poison, as proven in
          // the ownership lane. Poison is a property of the QUEUE, so the
          // probe for "the owner is unusable" must be another WRITE.
          ctx("registerPeer", { workspace_name: ALPHA, peer_id: idOf("r3aPeer"), name: "r3a-peer" }),
        ],
        contextThrowAt: { name: "after_write", occurrence: 1 },
      });

      const thrown = resultOf(events, 0);
      expect(thrown.ok).toBe(false);
      expect(thrown.error.code).toBe("recovery_required");

      // The row DID land (fail-stop, not rollback) before the hook threw.
      const rows = await rawSupersedeLogRows(fixture.datasetRoot);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.old_id).toBe(NODE_J);

      // Every later WRITE on the SAME owner is refused too.
      const poisoned = resultOf(events, 1);
      expect(poisoned.ok).toBe(false);
      expect(poisoned.error.code).toBe("recovery_required");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── R4: a real SDK failure normalizes; a safe governed error keeps its class ─

describe("R4: a real SDK failure surfaces recovery_required; a genuinely safe governed error keeps its own class", () => {
  test(
    "a locked supersede_log table makes the append itself fail, and the owner is poisoned",
    async () => {
      const NODE_K = idOf("r4nodeK");
      const REV_K1 = idOf("r4revK1");
      const fixture = await freshFixture("r4-sdk");
      const alpha = fixture.workspaces[ALPHA]!;
      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r4-k1", content: revisionEnvelope(ALPHA, alpha, NODE_K) })],
        [REV_K1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");

      const events = await runToCompletion(fixture.datasetRoot, {
        ops: [
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_K,
            expected_revision_id: REV_K1,
            reason: "R4 real SDK failure",
            peer_name: null,
            operation_id: "op-r4-locked",
          }),
          { facade: "harness", method: "unlockTable", request: { table: "supersede_log" } },
        ],
        // Locking fires from INSIDE the "before_write" boundary -- immediately
        // before the product's own SDK append call, so every earlier read
        // (the node lookup, the already-terminal check, the revision lookup,
        // the allocator's maximum) has already succeeded and only the append
        // itself hits a real, unrecovered permission failure.
        contextLockAt: { name: "before_write", occurrence: 1, table: "supersede_log" },
      });

      const failure = resultOf(events, 0);
      expect(failure.ok).toBe(false);
      // Normalized: whatever the real filesystem error was, the caller sees
      // the owner's own ambiguous-window code, never a raw SDK error.
      expect(failure.error.code).toBe("recovery_required");
      expect(failure.error.name).toBe("PublicationError");

      const unlocked = resultOf(events, 1);
      expect(unlocked.ok).toBe(true);

      // A FRESH owner, after the repair, works normally.
      const retried = await runToCompletion(fixture.datasetRoot, {
        ops: [ctx("retireNode", {
          workspace_name: ALPHA,
          node_id: NODE_K,
          expected_revision_id: REV_K1,
          reason: "R4 retry after repair",
          peer_name: null,
          operation_id: "op-r4-retry",
        })],
      });
      expect(resultOf(retried, 0).ok).toBe(true);
      expect(resultOf(retried, 0).value.outcome).toBe("accepted");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a planted duplicate (workspace_name, operation_id) row at readback throws the store's OWN integrity_failure, not a normalized recovery_required — and still poisons",
    async () => {
      const NODE_L = idOf("r4nodeL");
      const REV_L1 = idOf("r4revL1");
      const fixture = await freshFixture("r4-safe");
      const alpha = fixture.workspaces[ALPHA]!;
      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r4s-l1", content: revisionEnvelope(ALPHA, alpha, NODE_L) })],
        [REV_L1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");

      const OP_ID = "op-r4-duplicate";
      const events = await runToCompletion(fixture.datasetRoot, {
        ops: [
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_L,
            expected_revision_id: REV_L1,
            reason: "R4 safe-error probe",
            peer_name: null,
            operation_id: OP_ID,
          }),
          // A WRITE, not a read: poison is a property of the queue, and a
          // read would survive it regardless (proven in the ownership lane).
          ctx("registerPeer", { workspace_name: ALPHA, peer_id: idOf("r4safePeer"), name: "r4-safe-peer" }),
        ],
        clockMs: 1_790_200_000_000,
        contextInjectAt: { name: "after_write", occurrence: 1 },
        injection: {
          id: "500000",
          workspace_name: ALPHA,
          old_id: NODE_L,
          old_revision_id: REV_L1,
          old_title: "a title",
          old_type: alpha.term_ids.type.note.name,
          new_id: null,
          new_revision_id: null,
          reason: "planted duplicate",
          operation_id: OP_ID,
          superseded_at_micros: "1790200000000000",
        },
      });

      const failure = resultOf(events, 0);
      expect(failure.ok).toBe(false);
      // The STORE's own uniqueness check fired (`contextOne` sees two rows
      // for this operation_id) and its class survives — never coerced into
      // the generic ambiguous-window code.
      expect(failure.error.code).toBe("integrity_failure");
      expect(failure.error.name).toBe("PublicationError");

      // The owner is poisoned regardless of the error's own class.
      const poisoned = resultOf(events, 1);
      expect(poisoned.ok).toBe(false);
      expect(poisoned.error.code).toBe("recovery_required");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── R5: supersede vs retire is null-ness only; a half-null pair is corrupt ──

describe("R5: a half-null new_id/new_revision_id pair is integrity_failure, not a guessed classification", () => {
  test(
    "listLifecycleHistory refuses to decode a planted row with exactly one of the pair null",
    async () => {
      const NODE_M = idOf("r5nodeM");
      const REV_M1 = idOf("r5revM1");
      const HALF_NEW_ID = idOf("r5halfnewid");
      const fixture = await freshFixture("r5");
      const alpha = fixture.workspaces[ALPHA]!;
      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r5-m1", content: revisionEnvelope(ALPHA, alpha, NODE_M) })],
        [REV_M1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");

      const events = await runToCompletion(fixture.datasetRoot, {
        ops: [
          {
            facade: "harness",
            method: "injectHalfNullRow",
            request: {
              id: "777",
              workspace_name: ALPHA,
              old_id: NODE_M,
              old_revision_id: REV_M1,
              old_title: "a title",
              old_type: alpha.term_ids.type.note.name,
              new_id: HALF_NEW_ID,
              new_revision_id: null,
              reason: "half-null probe",
              operation_id: "op-r5-halfnull",
              superseded_at_micros: "1790300000000000",
            },
          },
          ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: NODE_M, after_event_id: null, limit: 10 }),
        ],
      });

      expect(resultOf(events, 0).ok).toBe(true);
      const failure = resultOf(events, 1);
      expect(failure.ok).toBe(false);
      expect(failure.error.code).toBe("integrity_failure");
      expect(failure.error.name).toBe("PublicationError");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── R6: LC-2 under a real crash, and the ordering rule around retirement ────

describe("R6: an orphan cannot resume onto a node retired in the meantime (real crash); a pre-retirement publish still replays idempotent", () => {
  test(
    "orphan resume is refused after retirement; the earlier ACKed publish replays idempotent; a genuinely new revision is refused",
    async () => {
      const NODE_N = idOf("r6nodeN");
      const REV_N1 = idOf("r6revN1");
      const REV_N2 = idOf("r6revN2");
      const fixture = await freshFixture("r6");
      const alpha = fixture.workspaces[ALPHA]!;

      // The first, fully-ACKed publish — this is the one whose LATER replay
      // must stay idempotent, in contrast with the orphan below.
      const seeded = await runOps(
        fixture,
        [pub("publishRevision", { operation_id: "op-r6-n1", content: revisionEnvelope(ALPHA, alpha, NODE_N) })],
        [REV_N1],
      );
      expect(seeded.op0.value.outcome).toBe("accepted");

      // A genuine orphan: killed after the revision row lands but BEFORE the
      // node's head moves — the same ambiguous window a real crash leaves.
      const orphanContent = revisionEnvelope(ALPHA, alpha, NODE_N, {
        base_revision_id: REV_N1,
        title: "orphan title",
      });
      const crashed = spawnRecovery(fixture.datasetRoot, {
        ops: [pub("publishRevision", { operation_id: "op-r6-orphan", content: orphanContent })],
        revisionIds: [REV_N2],
        clockMs: 1_790_400_000_000,
        genericParkAt: { name: "after_revision_append", occurrence: 1 },
      });
      let crashSeen: Event[];
      try {
        const drained = await drainUntil(crashed, (e) => e.event === "parked");
        crashSeen = drained.seen;
      } finally {
        await killAndReap(crashed);
      }
      expect(crashSeen.some((e) => e.event === "result")).toBe(false);

      // Retire the node — its head never moved, so the pin still matches.
      const retired = await runToCompletion(fixture.datasetRoot, {
        ops: [ctx("retireNode", {
          workspace_name: ALPHA,
          node_id: NODE_N,
          expected_revision_id: REV_N1,
          reason: "retired while an orphan was pending",
          peer_name: null,
          operation_id: "op-r6-retire",
        })],
      });
      expect(resultOf(retired, 0).ok).toBe(true);
      expect(resultOf(retired, 0).value.outcome).toBe("accepted");

      // LC-2: retrying the orphan MUST be refused, never an advanced head
      // onto a retired node.
      const orphanRetry = await runToCompletion(fixture.datasetRoot, {
        ops: [pub("publishRevision", { operation_id: "op-r6-orphan", content: orphanContent })],
      });
      const orphanResult = resultOf(orphanRetry, 0);
      expect(orphanResult.ok).toBe(true);
      expect(orphanResult.value).toEqual({ outcome: "conflict", reason: "node_retired" });

      // Ordering rule, other direction: the EARLIER, already-ACKed publish
      // (op-r6-n1, which succeeded BEFORE retirement) still replays
      // idempotent — retirement does not retroactively break a settled
      // operation.
      const earlierReplay = await runToCompletion(fixture.datasetRoot, {
        ops: [pub("publishRevision", {
          operation_id: "op-r6-n1",
          content: revisionEnvelope(ALPHA, alpha, NODE_N),
        })],
      });
      const earlierResult = resultOf(earlierReplay, 0);
      expect(earlierResult.ok).toBe(true);
      expect(earlierResult.value.outcome).toBe("idempotent");

      // A genuinely NEW revision on the retired node is refused, same code.
      const genuinelyNew = await runToCompletion(fixture.datasetRoot, {
        ops: [pub("publishRevision", {
          operation_id: "op-r6-genuinely-new",
          content: revisionEnvelope(ALPHA, alpha, NODE_N, { base_revision_id: REV_N1, title: "should be refused" }),
        })],
      });
      const newResult = resultOf(genuinelyNew, 0);
      expect(newResult.ok).toBe(true);
      expect(newResult.value).toEqual({ outcome: "conflict", reason: "node_retired" });
    },
    TEST_TIMEOUT_MS,
  );
});
