// #29 lifecycle ownership evidence — four context-bearing facades, the
// shared writer gate, and poison propagating in both directions between a
// lifecycle write (retireNode/supersedeNode) and an ordinary context write
// (registerPeer). Refs #29, Parent #28.
//
// Shape copied from the accepted, hard-reviewed `read-cursor-ownership.test.ts`
// (#72): same four-factory facade proof, same one-gate/one-close/one-shot
// proof, same queue-poison-in-both-directions proof — retargeted at the
// lifecycle kernel's own methods instead of the cursor's.
//
// Every expected value is authored HERE, derived from the MERGED
// `src/publication/service.ts` (never handed a count): `createContextWriterService`
// spreads `createContextReadMethods` (11 methods) and adds its own eleven
// (`advanceReadCursor`, `appendMessages`, `createSessionLink`, `createTrace`,
// `indexRevisionChunks`, `joinSession`, `registerPeer`, `registerSession`,
// `retireNode`, `supersedeNode`, plus the read methods folded in via spread),
// for 22 total on the writer and 11 on the reader — see
// `service.ts:3084` (`createContextReadMethods`), `service.ts:3803-3908`
// (`createContextWriterService`, `...reads` spread), and `service.ts:4547-4633`
// (`retireNode`/`supersedeNode`). `evidence` reuses the identical
// `createContextWriterService`/`createContextReadMethods` for its own nested
// `context` facade (`service.ts:6445-6448`, `service.ts:6396`), so its lists
// are the SAME closed sets, not independently derived ones.
//
// §6-equivalent error discipline: PublicationError literals asserted as closed
// objects; the wire fields compared field-by-field, never by substring.
//
// Bounded claims: one cooperative local gate, disposable fixtures, pinned Bun
// and Python on Darwin. Boundary hooks prove commanded ordering, not real SDK
// failure — that is `lifecycle-recovery.test.ts`'s job.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createFixture,
  revisionEnvelope,
  runGated,
  spawnGatedChild,
  type Fixture,
} from "./helpers/publication-fixture";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const CHILD = join(TEST_DIR, "fixtures", "lifecycle-v1", "ownership", "lifecycle-child.ts");
const TEST_TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";

// ── independent oracles, derived from the merged service.ts (see header) ────

const RUNTIME_EXPORTS = [
  "PublicationError",
  "openContextReader",
  "openContextWriter",
  "openEvidenceReader",
  "openEvidenceWriter",
  "openKnowledgeReader",
  "openKnowledgeWriter",
  "openPublicationReader",
  "openPublicationWriter",
].join(",");
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,answerChat,appendMessages,createSessionLink,createTrace,getContext," +
  "getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "indexRevisionChunks,joinSession,listConnections,listLifecycleHistory,listMcpCalls," +
  "listMessages,listPeers,listSearchChunks,listSessionLinks,listSessions,listTraceHits," +
  "reconcileSearchChunks,registerPeer,registerSession,retireNode,searchKnowledgeKeyword," +
  "searchKnowledgeSemantic,supersedeNode," +
  "writeChunkEmbedding";
const CONTEXT_READ_METHODS =
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "listConnections,listLifecycleHistory,listMcpCalls,listMessages,listPeers," +
  "listSearchChunks,listSessionLinks,listSessions,listTraceHits,searchKnowledgeKeyword," +
  "searchKnowledgeSemantic";
const CONTEXT_WRITER_KEYS = "close,context,publication,taxonomy";
const EVIDENCE_WRITER_KEYS = "close,context,evidence,publication,taxonomy";
const CONTEXT_READER_KEYS = "context,publication,taxonomy";
const EVIDENCE_READER_KEYS = "context,evidence,publication,taxonomy";

const pubError = (code: string, path: string, message: string) => ({
  name: "PublicationError",
  version: "arra-publication-error/v1",
  code,
  path,
  message,
});
const RECOVERY_REQUIRED = "writer recovery required";

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_A = idOf("lcownAnode");
const NODE_B = idOf("lcownBnode");
const REV_A1 = idOf("lcownArev1");
const REV_B1 = idOf("lcownBrev1");

const pub = (label: string, method: string, request: unknown) => ({ label, facade: "publication", method, request });

// ── scratch ──────────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-lifecycle-ownership-"));
const cleanups: { label: string; run: () => Promise<void> }[] = [];

async function freshFixture(label: string): Promise<Fixture> {
  const fixture = await createFixture([ALPHA]);
  cleanups.push({ label, run: fixture.cleanup });
  return fixture;
}

function payloadFile(name: string, value: Record<string, unknown>): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

const eventsOf = (stdout: string): string[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => line.slice("EVENT ".length).trim());

type Envelope = { ok: boolean; value?: unknown; error?: Record<string, unknown> };
const envelopeFor = (events: string[], label: string): Envelope => {
  const line = events.find((event) => event.startsWith(`json:${label} `));
  if (line === undefined) throw new Error(`no result for ${label}; saw ${JSON.stringify(events)}`);
  return JSON.parse(line.slice(`json:${label} `.length)) as Envelope;
};
const okValue = (events: string[], label: string): unknown => {
  const envelope = envelopeFor(events, label);
  expect({ label, ok: envelope.ok, error: envelope.error ?? null }).toEqual({ label, ok: true, error: null });
  return envelope.value;
};

async function runOpsChild(
  root: string,
  label: string,
  steps: Array<Record<string, unknown>>,
  revisionIds: string[] = [],
): Promise<string[]> {
  const run = await runGated(root, CHILD, ["ops", root, payloadFile(label, { steps, revision_ids: revisionIds })]);
  expect({ label, code: run.code, stderr: run.stderr.slice(-500) }).toEqual({ label, code: 0, stderr: "" });
  return eventsOf(run.stdout);
}

/** Seed one published node per id, so retireNode and supersedeNode have real
 *  accepted revisions to pin against. */
async function seedNodes(fixture: Fixture, label: string, nodes: string[], revs: string[]): Promise<void> {
  const alpha = fixture.workspaces[ALPHA]!;
  const steps = nodes.map((node, i) =>
    pub(`seed-${i}`, "publishRevision", {
      operation_id: `seed-op-${label}-${i}`,
      content: revisionEnvelope(ALPHA, alpha, node),
    }),
  );
  const events = await runOpsChild(fixture.datasetRoot, `${label}-seed`, steps, revs);
  for (let i = 0; i < nodes.length; i++) {
    const value = okValue(events, `seed-${i}`) as { outcome?: string };
    expect({ label, i, outcome: value.outcome }).toEqual({ label, i, outcome: "accepted" });
  }
}

afterAll(async () => {
  const failures: string[] = [];
  for (const { label, run } of cleanups) {
    await run().catch((error: unknown) => failures.push(`${label}: ${String(error)}`));
  }
  rmSync(scratch, { recursive: true, force: true });
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

// ── four context-bearing facades ─────────────────────────────────────────────

describe("context facades across all four factories", () => {
  test(
    "each writer facade carries twenty-two methods (union of reads+writes) and each reader facade eleven, with exports unchanged at nine",
    async () => {
      const fixture = await freshFixture("facades");
      const root = fixture.datasetRoot;
      for (const [factory, keys] of [
        ["context", CONTEXT_WRITER_KEYS],
        ["evidence", EVIDENCE_WRITER_KEYS],
      ] as const) {
        const run = await runGated(root, CHILD, ["writer-surface", root, payloadFile(`facade-${factory}`, { factory })]);
        expect({ factory, code: run.code, stderr: run.stderr.slice(-500) }).toEqual({ factory, code: 0, stderr: "" });
        const events = eventsOf(run.stdout);
        expect(events.find((e) => e.startsWith(`writer:${factory}:keys`))).toBe(`writer:${factory}:keys ${keys}`);
        expect(events.find((e) => e.startsWith(`writer:${factory}:context`))).toBe(
          `writer:${factory}:context ${CONTEXT_WRITE_METHODS}`,
        );
        expect(events.find((e) => e.startsWith(`writer:${factory}:valuetypes`))).toBe(
          `writer:${factory}:valuetypes function`,
        );
        expect(events.find((e) => e.startsWith(`writer:${factory}:exports`))).toBe(
          `writer:${factory}:exports ${RUNTIME_EXPORTS}`,
        );
      }

      const readerRun = await runGated(root, CHILD, ["reader-surfaces", root, payloadFile("facade-readers", {})]);
      expect({ code: readerRun.code, stderr: readerRun.stderr.slice(-500) }).toEqual({ code: 0, stderr: "" });
      const readerEvents = eventsOf(readerRun.stdout);
      expect(readerEvents.find((e) => e.startsWith("reader:context:keys"))).toBe(
        `reader:context:keys ${CONTEXT_READER_KEYS}`,
      );
      expect(readerEvents.find((e) => e.startsWith("reader:evidence:keys"))).toBe(
        `reader:evidence:keys ${EVIDENCE_READER_KEYS}`,
      );
      for (const factory of ["context", "evidence"] as const) {
        expect(readerEvents.find((e) => e.startsWith(`reader:${factory}:context`))).toBe(
          `reader:${factory}:context ${CONTEXT_READ_METHODS}`,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ── shared owner: queue, poison in both directions, one-shot close ───────────

describe("shared owner lifecycle", () => {
  test(
    "a poisoned LIFECYCLE write (retireNode) leaves the attempted event readable, and blocks a queued context write",
    async () => {
      const fixture = await freshFixture("poison-lifecycle");
      await seedNodes(fixture, "poison-lifecycle", [NODE_A], [REV_A1]);
      const root = fixture.datasetRoot;

      const owner = spawnGatedChild(root, CHILD, [
        "queue-poison",
        root,
        payloadFile("poison-lifecycle", {
          park_at: "before_write",
          throw_at: "after_write",
          hold_ms: 20_000,
          first: {
            method: "retireNode",
            request: {
              workspace_name: ALPHA,
              node_id: NODE_A,
              expected_revision_id: REV_A1,
              reason: "poison probe",
              peer_name: null,
              operation_id: "op-poison-lifecycle",
            },
          },
          second: {
            method: "registerPeer",
            request: { workspace_name: ALPHA, peer_id: idOf("lcownPeer1"), name: "lcown-peer-1" },
          },
          get: { method: "getRecallEligibility", request: { workspace_name: ALPHA, node_id: NODE_A } },
          lifecycle_after: {
            method: "retireNode",
            request: {
              workspace_name: ALPHA,
              node_id: NODE_A,
              expected_revision_id: REV_A1,
              reason: "after poison",
              peer_name: null,
              operation_id: "op-poison-lifecycle-after",
            },
          },
          peer_request: { workspace_name: ALPHA, peer_id: idOf("lcownPeer2"), name: "lcown-peer-2" },
        }),
      ]);

      const seen: string[] = [];
      const readUntil = async (name: string): Promise<string> => {
        for (;;) {
          const line = await owner.nextLine(TEST_TIMEOUT_MS / 2);
          if (!line.startsWith("EVENT ")) continue;
          const event = line.slice("EVENT ".length).trim();
          seen.push(event);
          if (event === name || event.startsWith(`${name} `)) return event;
        }
      };
      const envelopeUntil = async (label: string): Promise<Envelope> =>
        JSON.parse((await readUntil(`json:${label}`)).slice(`json:${label} `.length)) as Envelope;
      const expectPoisoned = async (label: string) => {
        const envelope = await envelopeUntil(label);
        expect({ label, ok: envelope.ok }).toEqual({ label, ok: false });
        expect(envelope.error).toEqual(pubError("recovery_required", "", RECOVERY_REQUIRED));
      };

      try {
        expect(await readUntil("lifecycle:parked")).toBe("lifecycle:parked");
        // The retire hasn't landed yet: still eligible.
        const parkedGet = await envelopeUntil("parked:get");
        expect(parkedGet).toEqual({ ok: true, value: { eligible: true, witness_event_id: "0" } });
        expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

        await expectPoisoned("write:first");
        await expectPoisoned("write:second");
        // Both directions on one owner: a lifecycle write and a context write.
        await expectPoisoned("lifecycle:write-after");
        await expectPoisoned("context:write-after");
        // §1-equivalent: reads survive poison. The fail-stop write DID append
        // its row (the boundary threw AFTER the append), so eligibility now
        // reads false with witness "1" -- attempted means reached the store.
        const poisonedGet = await envelopeUntil("poisoned:get");
        expect(poisonedGet).toEqual({ ok: true, value: { eligible: false, witness_event_id: "1" } });
        await expectPoisoned("released:get");
        expect(await readUntil("owner:alive")).toBe("owner:alive");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a poisoned CONTEXT write (registerPeer) blocks a queued lifecycle write, and the node stays eligible",
    async () => {
      const fixture = await freshFixture("poison-context");
      await seedNodes(fixture, "poison-context", [NODE_B], [REV_B1]);
      const root = fixture.datasetRoot;

      const owner = spawnGatedChild(root, CHILD, [
        "queue-poison",
        root,
        payloadFile("poison-context", {
          park_at: "before_write",
          throw_at: "after_write",
          hold_ms: 20_000,
          first: {
            method: "registerPeer",
            request: { workspace_name: ALPHA, peer_id: idOf("lcownPeer3"), name: "lcown-peer-3" },
          },
          second: {
            method: "retireNode",
            request: {
              workspace_name: ALPHA,
              node_id: NODE_B,
              expected_revision_id: REV_B1,
              reason: "queued behind the poisoned peer write",
              peer_name: null,
              operation_id: "op-poison-context",
            },
          },
          get: { method: "getRecallEligibility", request: { workspace_name: ALPHA, node_id: NODE_B } },
          lifecycle_after: {
            method: "retireNode",
            request: {
              workspace_name: ALPHA,
              node_id: NODE_B,
              expected_revision_id: REV_B1,
              reason: "after poison",
              peer_name: null,
              operation_id: "op-poison-context-after",
            },
          },
          peer_request: { workspace_name: ALPHA, peer_id: idOf("lcownPeer4"), name: "lcown-peer-4" },
          peer_get_request: { workspace_name: ALPHA, peer_name: "lcown-peer-3" },
        }),
      ]);

      const seen: string[] = [];
      const readUntil = async (name: string): Promise<string> => {
        for (;;) {
          const line = await owner.nextLine(TEST_TIMEOUT_MS / 2);
          if (!line.startsWith("EVENT ")) continue;
          const event = line.slice("EVENT ".length).trim();
          seen.push(event);
          if (event === name || event.startsWith(`${name} `)) return event;
        }
      };
      const envelopeUntil = async (label: string): Promise<Envelope> =>
        JSON.parse((await readUntil(`json:${label}`)).slice(`json:${label} `.length)) as Envelope;
      const expectPoisoned = async (label: string) => {
        const envelope = await envelopeUntil(label);
        expect({ label, ok: envelope.ok }).toEqual({ label, ok: false });
        expect(envelope.error).toEqual(pubError("recovery_required", "", RECOVERY_REQUIRED));
      };

      try {
        expect(await readUntil("lifecycle:parked")).toBe("lifecycle:parked");
        const parkedGet = await envelopeUntil("parked:get");
        expect(parkedGet).toEqual({ ok: true, value: { eligible: true, witness_event_id: "0" } });
        expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

        await expectPoisoned("write:first");
        await expectPoisoned("write:second");
        await expectPoisoned("lifecycle:write-after");
        await expectPoisoned("context:write-after");
        // The queued retireNode never ran: still eligible, witness still "0".
        const poisonedGet = await envelopeUntil("poisoned:get");
        expect(poisonedGet).toEqual({ ok: true, value: { eligible: true, witness_event_id: "0" } });
        // The peer write DID land before its boundary threw.
        const peerGet = await envelopeUntil("poisoned:peer-get");
        expect(peerGet.ok).toBe(true);
        expect((peerGet.value as { name?: string } | null)?.name).toBe("lcown-peer-3");
        await expectPoisoned("released:get");
        expect(await readUntil("owner:alive")).toBe("owner:alive");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a context writer excludes every other factory and spelling, and close is one-shot",
    async () => {
      const fixture = await freshFixture("cross-factory");
      const root = fixture.datasetRoot;
      const alias = join(scratch, "lifecycle-alias");
      symlinkSync(root, alias);
      const owner = spawnGatedChild(root, CHILD, [
        "cross-factory",
        root,
        payloadFile("cross-factory", { alias, hold_ms: 20_000 }),
      ]);

      const readUntil = async (name: string): Promise<string> => {
        for (;;) {
          const line = await owner.nextLine(TEST_TIMEOUT_MS / 2);
          if (!line.startsWith("EVENT ")) continue;
          const event = line.slice("EVENT ".length).trim();
          if (event === name || event.startsWith(`${name} `)) return event;
        }
      };

      try {
        expect(await readUntil("owner:context")).toBe("owner:context ready");
        for (const label of ["second:context", "second:evidence", "second:alias"]) {
          expect(await readUntil(label)).toBe(`${label} writer_unavailable`);
        }
        expect(await readUntil("close:same-promise")).toBe("close:same-promise true");
        expect(await readUntil("close:resolved")).toBe("close:resolved");
        expect(await readUntil("reopen:after-close")).toBe("reopen:after-close writer_unavailable");
        expect(await readUntil("owner:alive")).toBe("owner:alive");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
