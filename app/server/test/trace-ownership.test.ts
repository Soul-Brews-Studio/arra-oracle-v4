// #28 trace ownership evidence — four context-bearing facades, shared
// queue/poison in both directions, one-shot close, and cross-factory
// exclusion. Modelled on the accepted, hard-reviewed
// `read-cursor-ownership.test.ts` (§8 OWNERSHIP), generalised for the trace
// kernel's own write shape.
//
// Authority: `app/docs/contracts/trace-v1.md` (§§1-9, base f600636, five
// kernels integrated, full suite 766/0). Unit trap, ambiguous-partial retry,
// position-gap and year-0000 refusal belong to `trace-recovery.test.ts`;
// method semantics and grammar to `trace-service.test.ts`. None is duplicated
// here.
//
// Every expected value is authored HERE from the contract: facade key sets,
// the nine runtime exports, row field order, outcomes and error envelopes.
// Requests are built in this file, so no builder can define its own
// expectations.
//
// §6 error discipline, applied literally: PublicationError literals are
// asserted exactly as closed objects; governed deterministic cases are
// compared as closed objects too, against the ACTUAL accepted call-site text.
//
// Bounded claims: one cooperative local gate, disposable fixtures, pinned Bun
// and Python on Darwin. Boundary hooks prove commanded ordering, not real SDK
// failure (that is `trace-recovery.test.ts`'s job). Nothing here speaks to
// Linux, NFS, R2, multiwriter CAS, power loss, or to admission.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContextFixture } from "./helpers/context-fixture";
import { PYTHON, runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";
import { traceId, hitInput } from "./helpers/trace-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";
import { scaledMs } from "./helpers/timing.scaledMs";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OWNERSHIP_CHILD = join(TEST_DIR, "fixtures", "trace-v1", "ownership", "trace-child.ts");
const TEST_TIMEOUT_MS = testTimeout(180_000);
const ALPHA = "alpha-workspace";

// ── independent oracles, authored from the contract ──────────────────────────

/** §1: the runtime export set — measured independently against the actual
 *  exported `open*` functions plus `PublicationError`, not copied from a
 *  count handed to this file. */
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
/** §1: thirty-three on every context WRITER facade, twenty-one on every context
 *  READER facade — derived from `service.ts`'s actual returned method sets
 *  across all five integrated kernels (createTrace/getTrace/listTraceHits/
 *  listTraces and indexRevisionChunks/listSearchChunks/
 *  reconcileSearchChunks included), independently confirmed by reading the
 *  source, not handed a count. `listTraces` is K5 (docs/overnight/
 *  V3-PARITY.md §5, overnight R18), added the same slice as `oracle_trace`. */
// #30 overnight R7/R8: `getSearchFreshness` (read) and `embedPendingChunks`
// (write-only) join the context facade -- both lists below grew accordingly.
// Overnight R18: + closeSession (K9, D7) on every writer, + listSessionMembers (K10) on both.
// Overnight R18 (V3 + K5 + V7): + listTraces (K5) on both.
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,appendMessages,closeSession,createSessionLink,createTrace,embedPendingChunks," +
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSearchFreshness," +
  "getSession,getTrace," +
  "indexRevisionChunks,joinSession,listConnections,listLifecycleHistory,listMcpCalls," +
  "listMessages,listPeers,listSearchChunks,listSessionLinks,listSessionMembers,listSessions,listTraceHits," +
  "listTraces,reconcileSearchChunks,registerPeer,registerSession,retireNode,supersedeNode," +
  "writeChunkEmbedding";
const CONTEXT_READ_METHODS =
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSearchFreshness," +
  "getSession,getTrace," +
  "listConnections,listLifecycleHistory,listMcpCalls,listMessages,listPeers," +
  "listSearchChunks,listSessionLinks,listSessionMembers,listSessions,listTraceHits,listTraces," +
  "searchKnowledgeKeyword,searchKnowledgeSemantic";
const CONTEXT_WRITER_KEYS = "close,context,publication,taxonomy";
const EVIDENCE_WRITER_KEYS = "close,context,evidence,publication,taxonomy";
const CONTEXT_READER_KEYS = "context,publication,taxonomy";
const EVIDENCE_READER_KEYS = "context,evidence,publication,taxonomy";
/** §2: the twenty physical `traces` columns, in exact order. */
const TRACE_ROW_FIELDS = [
  "id", "name", "workspace_name", "session_name", "peer_name", "query", "mode",
  "session_id", "session_from_ts", "session_to_ts", "friction_score", "confidence",
  "parent_id", "prev_id", "depth", "status", "h_metadata", "internal_metadata",
  "created_at", "updated_at",
];
const CLOCK_MS = 1_790_000_000_000;
const CLOCK_TEXT = new Date(CLOCK_MS).toISOString();

const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);

/** A minimal, zero-hit trace request: exactly ONE writeRow triple per call,
 *  so boundary-name occurrence counts stay predictable across this file. */
const traceRequest = (traceKey: string, overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  id: traceId(traceKey),
  name: "trace-a",
  session_name: null,
  peer_name: null,
  query: "find the bug",
  mode: null,
  session_id: null,
  session_from_ts: null,
  session_to_ts: null,
  friction_score: null,
  confidence: null,
  parent_id: null,
  prev_id: null,
  depth: "0",
  status: "open",
  h_metadata: null,
  internal_metadata: null,
  hits: [],
  ...overrides,
});
/** The complete row a zero-hit createTrace at the pinned clock must produce,
 *  authored HERE — never echoed back from the write under test. */
const traceRow = (traceKey: string, overrides: Record<string, unknown> = {}) => ({
  id: traceId(traceKey),
  name: "trace-a",
  workspace_name: ALPHA,
  session_name: null,
  peer_name: null,
  query: "find the bug",
  mode: null,
  session_id: null,
  session_from_ts: null,
  session_to_ts: null,
  friction_score: null,
  confidence: null,
  parent_id: null,
  prev_id: null,
  depth: "0",
  status: "open",
  h_metadata: null,
  internal_metadata: null,
  created_at: CLOCK_TEXT,
  updated_at: CLOCK_TEXT,
  ...overrides,
});

const pubError = (code: string, path: string, message: string) => ({
  name: "PublicationError",
  version: "arra-publication-error/v1",
  code,
  path,
  message,
});
const RECOVERY_REQUIRED = "writer recovery required";
const peerRow = (peerId: string, peerName: string) => ({
  id: peerId,
  name: peerName,
  workspace_name: ALPHA,
  h_metadata: null,
  internal_metadata: null,
  configuration: null,
  created_at: CLOCK_TEXT,
});

// ── scratch ──────────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-trace-ownership-"));
const cleanups: { label: string; run: () => Promise<void> }[] = [];

async function freshDataset(label: string): Promise<string> {
  const fixture = await createContextFixture([ALPHA]);
  cleanups.push({ label, run: fixture.cleanup });
  return fixture.datasetRoot;
}

function payloadFile(name: string, value: Record<string, unknown>): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify({ workspace: ALPHA, clock_ms: CLOCK_MS, ...value }), { mode: 0o600 });
  return path;
}

const eventsOf = (stdout: string): string[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => line.slice("EVENT ".length).trim());

const eventFor = (events: string[], name: string): string =>
  events.find((event) => event === name || event.startsWith(`${name} `)) ??
  `MISSING ${name} (saw ${JSON.stringify(events)})`;

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
const errorOf = (events: string[], label: string): Record<string, unknown> => {
  const envelope = envelopeFor(events, label);
  expect({ label, ok: envelope.ok }).toEqual({ label, ok: false });
  return envelope.error!;
};

async function runChildOk(root: string, args: string[], label: string) {
  const run = await runGated(root, OWNERSHIP_CHILD, args);
  expect({ label, code: run.code, stderr: run.stderr.slice(-300) }).toEqual({ label, code: 0, stderr: "" });
  return eventsOf(run.stdout);
}

function ownerReader(owner: { nextLine(timeoutMs: number): Promise<string> }) {
  const readUntil = async (name: string): Promise<string> => {
    for (;;) {
      const line = await owner.nextLine(TEST_TIMEOUT_MS / 2);
      if (!line.startsWith("EVENT ")) continue;
      const event = line.slice("EVENT ".length).trim();
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
  const expectValue = async (label: string, value: Record<string, unknown> | null) => {
    const envelope = await envelopeUntil(label);
    expect({ label, ok: envelope.ok, error: envelope.error ?? null }).toEqual({ label, ok: true, error: null });
    expect({ label, value: (envelope.value ?? null) as Record<string, unknown> | null }).toEqual({ label, value });
  };
  return { readUntil, envelopeUntil, expectPoisoned, expectValue };
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
    "each writer facade carries thirty-three methods and each reader facade twenty-one, with exports unchanged",
    async () => {
      const root = await freshDataset("facades");
      for (const [factory, keys] of [
        ["context", CONTEXT_WRITER_KEYS],
        ["evidence", EVIDENCE_WRITER_KEYS],
      ] as const) {
        const events = await runChildOk(
          root,
          ["writer-surface", root, payloadFile(`facade-${factory}`, { factory })],
          `facade-${factory}`,
        );
        expect(eventFor(events, `writer:${factory}:keys`)).toBe(`writer:${factory}:keys ${keys}`);
        expect(eventFor(events, `writer:${factory}:context`)).toBe(
          `writer:${factory}:context ${CONTEXT_WRITE_METHODS}`,
        );
        expect(eventFor(events, `writer:${factory}:valuetypes`)).toBe(`writer:${factory}:valuetypes function`);
        expect(eventFor(events, `writer:${factory}:exports`)).toBe(`writer:${factory}:exports ${RUNTIME_EXPORTS}`);
      }

      const readerEvents = await runChildOk(
        root,
        ["reader-surfaces", root, payloadFile("facade-readers", {})],
        "facade-readers",
      );
      expect(eventFor(readerEvents, "reader:context:keys")).toBe(`reader:context:keys ${CONTEXT_READER_KEYS}`);
      expect(eventFor(readerEvents, "reader:evidence:keys")).toBe(`reader:evidence:keys ${EVIDENCE_READER_KEYS}`);
      for (const factory of ["context", "evidence"] as const) {
        expect(eventFor(readerEvents, `reader:${factory}:context`)).toBe(
          `reader:${factory}:context ${CONTEXT_READ_METHODS}`,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ── a fresh createTrace, authored as an oracle for the poison tests below ───

describe("shared owner: queue, poison in both directions, one-shot close", () => {
  const poisonedOwner = async (
    label: string,
    root: string,
    payload: Record<string, unknown>,
    expected: {
      parked: Record<string, unknown> | null;
      poisoned: Record<string, unknown> | null;
      peer?: Record<string, unknown> | null;
    },
  ) => {
    const owner = spawnGatedChild(root, OWNERSHIP_CHILD, [
      "queue-poison",
      root,
      payloadFile(label, {
        park_at: "before_write",
        // §5: the failure must come AFTER the row was attempted.
        throw_at: "after_write",
        hold_ms: 20_000,
        trace_after_method: "createTrace",
        trace_after_request: traceRequest(`${label}-after`),
        peer_request: { workspace_name: ALPHA, peer_id: id(`${label}-after`), name: `${label}-after` },
        ...payload,
      }),
    ]);
    const { readUntil, expectPoisoned, expectValue } = ownerReader(owner);
    try {
      expect(await readUntil("trace:parked")).toBe("trace:parked");
      // §1: reads bypass the write queue, so this answers mid-write, and it
      // answers from BEFORE the parked write — nothing has landed yet.
      await expectValue("parked:read", expected.parked);
      expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

      await expectPoisoned("write:first");
      await expectPoisoned("write:second");
      // Both directions on one owner: a trace write and a context write.
      await expectPoisoned("trace:write-after");
      await expectPoisoned("context:write-after");
      // §1: reads survive poison…
      await expectValue("poisoned:read", expected.poisoned);
      if (expected.peer !== undefined) await expectValue("poisoned:peer-get", expected.peer);
      // …and fail only after release.
      await expectPoisoned("released:read");
      expect(await readUntil("owner:alive")).toBe("owner:alive");
    } finally {
      owner.kill();
      await owner.wait().catch(() => undefined);
    }
  };

  test(
    "a poisoned trace write leaves the attempted row readable, and blocks a queued context write",
    async () => {
      const root = await freshDataset("poison-trace");
      const key = "poison-trace";
      await poisonedOwner(
        key,
        root,
        {
          first_method: "createTrace",
          first_request: traceRequest(key),
          second_method: "registerPeer",
          second_request: { workspace_name: ALPHA, peer_id: id("tr-peer-3"), name: "tr-third" },
          read_method: "getTrace",
          read_request: { workspace_name: ALPHA, id: traceId(key) },
        },
        {
          parked: null,
          // §5: the hook threw AFTER the append, so the row IS on disk. Poison
          // is fail-stop, not rollback: the trace row authored here (never
          // echoed back) is what a fresh read must find.
          poisoned: traceRow(key),
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a poisoned CONTEXT write blocks a queued trace write, and the trace stays absent",
    async () => {
      const root = await freshDataset("poison-context");
      const key = "poison-context";
      await poisonedOwner(
        key,
        root,
        {
          first_method: "registerPeer",
          first_request: { workspace_name: ALPHA, peer_id: id("tr-peer-5"), name: "tr-fifth" },
          second_method: "createTrace",
          second_request: traceRequest(key),
          read_method: "getTrace",
          read_request: { workspace_name: ALPHA, id: traceId(key) },
          peer_get_request: { workspace_name: ALPHA, peer_name: "tr-fifth" },
        },
        {
          parked: null,
          // The queued trace write never ran: no trace row was ever
          // attempted, so the read still answers, and it answers null.
          poisoned: null,
          // The peer write DID land before its boundary threw.
          peer: peerRow(id("tr-peer-5"), "tr-fifth"),
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a context writer excludes every other factory and spelling, and close is one-shot",
    async () => {
      const root = await freshDataset("cross-factory");
      const alias = join(scratch, "trace-alias");
      symlinkSync(root, alias);
      const owner = spawnGatedChild(root, OWNERSHIP_CHILD, [
        "cross-factory",
        root,
        payloadFile("cross-factory", { alias, hold_ms: 20_000 }),
      ]);
      const { readUntil } = ownerReader(owner);

      try {
        expect(await readUntil("owner:context")).toBe("owner:context ready");
        for (const label of ["second:context", "second:evidence", "second:alias"]) {
          expect(await readUntil(label)).toBe(`${label} writer_unavailable`);
        }
        expect(await readUntil("close:same-promise")).toBe("close:same-promise true");
        expect(await readUntil("close:resolved")).toBe("close:resolved");
        expect(await readUntil("reopen:after-close")).toBe("reopen:after-close writer_unavailable");
        expect(await readUntil("owner:alive")).toBe("owner:alive");

        const contender = await runOwnedChild(
          PYTHON,
          [
            "-c",
            [
              "import sys",
              "from arra_migrate.writer_gate import writer_gate",
              "with writer_gate(sys.argv[1]):",
              "    print('EVENT gate:acquired')",
            ].join("\n"),
            root,
          ],
          { deadlineMs: scaledMs(30_000) },
        );
        expect({ code: contender.code, events: eventsOf(contender.stdout) }).toEqual({
          code: 0,
          events: ["gate:acquired"],
        });
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// Sanity: the fixture helper imports actually resolve to something usable —
// guards against a silent typo in the trace-fixture re-export shape.
describe("preflight", () => {
  test("hitInput builds a well-formed passive hit", () => {
    expect(hitInput().kind).toBe("url");
  });
});
