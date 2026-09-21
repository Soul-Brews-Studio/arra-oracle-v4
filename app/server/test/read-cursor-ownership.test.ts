// #72 read-cursor ownership evidence — four context-bearing facades, scoped
// references and namespace, observer history without membership, shared
// queue/poison/close, and fully structured errors. Refs #72, Parent #28.
//
// Authority is `app/docs/contracts/read-cursor-v1.md`
// (SHA256 164d3e91211552e5146b36d8d8e0cb22a628e4aa7f22d1fe2b70ae9a9f6a9508), §8 OWNERSHIP.
// Ordering, clock and physical-wire edges belong to `read-cursor-precision.test.ts`;
// crash, real SDK failure and fresh-owner recovery to `read-cursor-recovery.test.ts`;
// method semantics and grammar to `read-cursor-service.test.ts`. None is duplicated here.
//
// Every expected value is authored HERE from the contract: facade key sets, the nine
// runtime exports, row field order, outcomes, conflict reasons and error envelopes.
// Requests are built in this file, so no builder can define its own expectations.
//
// §6 error discipline, applied literally: PublicationError literals are asserted exactly
// as closed objects; governed deterministic cases are compared as closed objects too,
// against the ACTUAL accepted call-site text — never invented replacement text. Where
// parser text is intentionally unconstrained, the check is nonempty and the narrower
// coverage is stated at the assertion.
//
// Dependency status, recorded once: `getReadCursor`/`advanceReadCursor` are ABSENT at
// authoring time, and the core lane (#71) has published no helper signatures yet, so this
// file consumes only the ACCEPTED `createContextFixture` and the accepted bounded child
// helpers. Suites skip with the blocker named; no skip is acceptance.
//
// Narrower than it looks, stated once: the raw-staged `left_at` is asserted as
// SET rather than as an exact value, because that column is staged outside this
// interface and read back engine-formatted. It proves the membership was left,
// not what microsecond it was left at; exact raw micros stay unmeasured here.
//
// Bounded claims: one cooperative local gate, disposable fixtures, pinned Bun and Python on
// Darwin. Boundary hooks prove commanded ordering, not real SDK failure. Nothing here
// speaks to Linux, NFS, R2, multiwriter CAS, power loss, or to admission, which stays
// #25/#31 work — a peer name in a request is not authorization.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContextFixture } from "./helpers/context-fixture";
import { PYTHON, runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OWNERSHIP_CHILD = join(TEST_DIR, "fixtures", "read-cursor-v1", "ownership", "cursor-child.ts");
const RAW_MUTATE = join(TEST_DIR, "fixtures", "read-cursor-v1", "ownership", "raw-mutate.ts");
const TEST_TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

// ── independent oracles, authored from the contract ──────────────────────────

/** §1: the runtime export set stays at the accepted nine. */
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
/** §1: twenty-two on every context WRITER facade (its own eleven plus the
 *  eleven reader methods it spreads in), eleven on every context READER
 *  facade. */
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,answerChat,appendMessages,createSessionLink,createTrace,getContext," +
  "getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "indexRevisionChunks,joinSession,listConnections,listLifecycleHistory,listMcpCalls," +
  "listMessages,listPeers,listSearchChunks,listSessionLinks,listSessions,listTraceHits," +
  "reconcileSearchChunks,registerPeer,registerSession,retireNode,supersedeNode," +
  "writeChunkEmbedding";
const CONTEXT_READ_METHODS =
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "listConnections,listLifecycleHistory,listMcpCalls,listMessages,listPeers," +
  "listSearchChunks,listSessionLinks,listSessions,listTraceHits";
/** Bundle keys are unchanged by this slice; nested facades never carry close. */
const CONTEXT_WRITER_KEYS = "close,context,publication,taxonomy";
const EVIDENCE_WRITER_KEYS = "close,context,evidence,publication,taxonomy";
const CONTEXT_READER_KEYS = "context,publication,taxonomy";
const EVIDENCE_READER_KEYS = "context,evidence,publication,taxonomy";
/** §2: the five physical columns, in exact order. */
const ROW_FIELDS = ["workspace_name", "peer_name", "session_name", "last_read_message_id", "last_read_at"];
/** §2/§4: the clock this file pins for every write, and the exact UTC-millisecond
 *  text it must render. Asserting this literal — rather than echoing the row the
 *  write returned — is what makes the row an oracle instead of a self-report. */
const CLOCK_MS = 1_789_905_600_000;
const CLOCK_TEXT = "2026-09-20T12:00:00.000Z";
/** The complete row every advance in this file must produce, authored here. */
const cursorRow = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  peer_name: NAMES.observer,
  session_name: NAMES.session,
  last_read_message_id: IDS.messageA,
  last_read_at: CLOCK_TEXT,
  ...overrides,
});

/** §6 envelopes and the publication literals this slice may emit. */
const pubError = (code: string, path: string, message: string) => ({
  name: "PublicationError",
  version: "arra-publication-error/v1",
  code,
  path,
  message,
});
const INVALID_REFERENCE = "invalid scoped reference";
/** A batch STOP carries the wire envelope only — `toJSON()` has no `name`, so
 *  asserting one here would pass against a thrown error that never happened. */
const wireError = (code: string, path: string) => ({
  version: "arra-publication-error/v1",
  code,
  path,
  message: INVALID_REFERENCE,
});
/** §1: a registered peer row, authored here from the request and the pinned
 *  clock. Used to prove a poisoned context write really reached the store. */
const peerRow = (peerId: string, peerName: string) => ({
  id: peerId,
  name: peerName,
  workspace_name: ALPHA,
  h_metadata: null,
  internal_metadata: null,
  configuration: null,
  created_at: CLOCK_TEXT,
});
/** §4 governed static grammar. `last_read_message_id` is a public_id, and the
 *  accepted parsers gate public_ids with `requireNanoid21` DIRECTLY — see
 *  `src/publication/context.ts:93` and `src/contracts/common.ts:19-22` — so a
 *  wrong-shape STRING and a non-string both land on one code and one message.
 *  This is the accepted call-site text, not replacement text; a parser that
 *  type-gated first would emit invalid_type/"expected string" and is a real
 *  divergence to report, which is exactly why the object is closed. */
const nanoidError = (path: string) => ({
  name: "ContractError",
  version: "arra-error/v1",
  code: "invalid_value",
  path,
  message: "expected a 21-character URL-safe id",
});
const RECOVERY_REQUIRED = "writer recovery required";

const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);
const IDS = {
  peer: id("rc-peer-1"),
  observer: id("rc-peer-2"),
  session: id("rc-session-1"),
  otherSession: id("rc-session-2"),
  messageA: id("rc-msg-a"),
  messageB: id("rc-msg-b"),
  otherSessionMessage: id("rc-msg-c"),
  absentMessage: id("rc-msg-absent"),
};
const NAMES = {
  peer: "rc-author",
  observer: "rc-observer",
  session: "rc-session-alpha",
  otherSession: "rc-session-beta",
};

// ── dependency probes ────────────────────────────────────────────────────────

// No catch: a module that cannot load is a real failure and must say so here,
// never a silent skip.
const service = (await import(join(SERVER_DIR, "src", "publication", "service.ts"))) as Record<string, unknown>;
/**
 * The cursor methods live on a facade, not on the module, so presence is probed
 * through the accepted reader factory rather than by guessing an export name.
 */
const probeReady = async (): Promise<boolean> => {
  const open = service.openContextReader as ((root: string) => Promise<Record<string, unknown>>) | undefined;
  // The ONLY absence this probe may report is a method that is not there yet.
  // A fixture that will not build or a factory that throws is a real error and
  // propagates, because a skip on those grounds would read as acceptance.
  if (typeof open !== "function") return false;
  const fixture = await createContextFixture([ALPHA]);
  try {
    const reader = await open(fixture.datasetRoot);
    const context = reader.context as Record<string, unknown> | undefined;
    return typeof context?.getReadCursor === "function" || typeof context?.advanceReadCursor === "function";
  } finally {
    await fixture.cleanup();
  }
};
/** Reader carries get only; the writer carries both. Either presence is enough
 *  to say the slice landed, and the suites assert the exact sets themselves. */
const READY = await probeReady();
const PENDING = READY ? "" : "pending getReadCursor/advanceReadCursor (#71 core)";

// ── scratch ──────────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-read-cursor-ownership-"));
const cleanups: { label: string; run: () => Promise<void> }[] = [];

async function freshDataset(label: string): Promise<string> {
  const fixture = await createContextFixture([ALPHA, BETA]);
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

/** Children RETURN exit codes; an unchecked child can die and leave empty output. */
async function runChildOk(root: string, args: string[], label: string) {
  const run = await runGated(root, OWNERSHIP_CHILD, args);
  expect({ label, code: run.code, stderr: run.stderr.slice(-300) }).toEqual({ label, code: 0, stderr: "" });
  return eventsOf(run.stdout);
}

/** One structured reader over a live gated owner's stdout: every result is a
 *  closed object, so nothing is judged by a substring or by the exit code. */
function ownerReader(owner: { nextLine(timeoutMs: number): Promise<string> }) {
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
  const expectValue = async (label: string, value: Record<string, unknown> | null) => {
    const envelope = await envelopeUntil(label);
    expect({ label, ok: envelope.ok, error: envelope.error ?? null }).toEqual({ label, ok: true, error: null });
    expect({ label, value: (envelope.value ?? null) as Record<string, unknown> | null }).toEqual({ label, value });
  };
  return { seen, readUntil, envelopeUntil, expectPoisoned, expectValue };
}

/** Requests, in the contract's exact closed grammar. */
const getRequest = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  peer_name: NAMES.observer,
  session_name: NAMES.session,
  ...overrides,
});
const advanceRequest = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  peer_name: NAMES.observer,
  session_name: NAMES.session,
  last_read_message_id: IDS.messageA,
  expected: null,
  ...overrides,
});
const messageItem = (publicId: string, content: string, peer: string = NAMES.peer) => ({
  public_id: publicId,
  message: { peer_name: peer, role: null, content, in_reply_to: null },
  source: null,
});

/** A dataset with two peers, two sessions and three messages, all mine. */
async function seededDataset(label: string): Promise<string> {
  const root = await freshDataset(label);
  const events = await runChildOk(
    root,
    [
      "setup",
      root,
      payloadFile(`${label}-setup`, {
        setup_methods: {
          peer: "registerPeer",
          observer: "registerPeer",
          session: "registerSession",
          other_session: "registerSession",
          join: "joinSession",
          join_other: "joinSession",
          messages: "appendMessages",
          other_messages: "appendMessages",
        },
        setup: {
          peer: { workspace_name: ALPHA, peer_id: IDS.peer, name: NAMES.peer },
          observer: { workspace_name: ALPHA, peer_id: IDS.observer, name: NAMES.observer },
          session: { workspace_name: ALPHA, session_id: IDS.session, name: NAMES.session },
          other_session: { workspace_name: ALPHA, session_id: IDS.otherSession, name: NAMES.otherSession },
          join: { workspace_name: ALPHA, session_name: NAMES.session, peer_name: NAMES.peer },
          join_other: { workspace_name: ALPHA, session_name: NAMES.otherSession, peer_name: NAMES.peer },
          messages: {
            workspace_name: ALPHA,
            session_name: NAMES.session,
            items: [messageItem(IDS.messageA, "first"), messageItem(IDS.messageB, "second")],
          },
          other_messages: {
            workspace_name: ALPHA,
            session_name: NAMES.otherSession,
            items: [messageItem(IDS.otherSessionMessage, "elsewhere")],
          },
        },
      }),
    ],
    `${label}-setup`,
  );

  // Setup identities are asserted, not assumed: a cursor aimed at a message this
  // file never created would refuse for the wrong reason.
  for (const step of ["peer", "observer", "session", "other_session", "join", "join_other"]) {
    expect({ step, outcome: (okValue(events, `setup:${step}`) as { outcome?: string }).outcome }).toEqual({
      step,
      outcome: "created",
    });
  }
  for (const step of ["messages", "other_messages"]) {
    const batch = okValue(events, `setup:${step}`) as { outcome?: string; results?: unknown[] };
    expect({ step, outcome: batch.outcome }).toEqual({ step, outcome: "complete" });
    expect((batch.results ?? []).length).toBeGreaterThan(0);
  }
  // The OBSERVER deliberately never joins: §3 requires no membership to read or
  // record progress, and every cursor case below uses that peer.
  return root;
}

/** One extra gated pass: the OBSERVER actually joins, so "left" can be reached
 *  by leaving rather than by never having been a member. */
async function joinObserver(root: string, label: string): Promise<void> {
  const events = await runChildOk(
    root,
    [
      "setup",
      root,
      payloadFile(`${label}-join-observer`, {
        setup_methods: { join_observer: "joinSession" },
        setup: { join_observer: { workspace_name: ALPHA, session_name: NAMES.session, peer_name: NAMES.observer } },
      }),
    ],
    `${label}-join-observer`,
  );
  expect({ label, outcome: (okValue(events, "setup:join_observer") as { outcome?: string }).outcome }).toEqual({
    label,
    outcome: "created",
  });
}

/** Stage a state this interface cannot produce, and return the rows the raw
 *  process actually observed afterwards. The premise is then ASSERTED by the
 *  caller: an update that silently matched nothing would otherwise leave a test
 *  passing on a state it never reached. */
async function stageRaw(
  root: string,
  op: "leave-membership" | "deactivate-session",
  args: string[],
  label: string,
): Promise<Record<string, unknown>[]> {
  const staged = await runGated(root, RAW_MUTATE, [op, root, ...args]);
  expect({ label, op, code: staged.code }).toEqual({ label, op, code: 0 });
  const events = eventsOf(staged.stdout);
  const name = op === "leave-membership" ? "raw:left" : "raw:deactivated";
  const event = eventFor(events, name);
  expect({ label, reported: event.startsWith(`${name} [`) }).toEqual({ label, reported: true });
  return JSON.parse(event.slice(name.length + 1)) as Record<string, unknown>[];
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

describe.skipIf(!READY)(`context facades across all four factories [${PENDING}]`, () => {
  test(
    "each writer facade carries twenty-two methods and each reader facade eleven, with exports unchanged",
    async () => {
      const root = await freshDataset("facades");
      // One writer per gated child: closing releases fd 42, so a second open in
      // the same process would be refused for gate reasons, not shape reasons.
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
        // §1: the runtime export set does not grow with facade methods.
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

// ── scoped references, namespace, observer history ───────────────────────────

describe.skipIf(!READY)(`scoped references and namespace [${PENDING}]`, () => {
  test(
    "an unjoined observer records progress, and every unresolvable reference names its own pointer",
    async () => {
      const root = await seededDataset("references");
      const events = await runChildOk(
        root,
        [
          "cursor-ops",
          root,
          payloadFile("references", {
            steps: [
              // §3: absent cursor reads as null, never an error.
              { label: "absent", method: "getReadCursor", request: getRequest() },
              // §3: the observer holds NO membership, and that must not block it.
              { label: "created", method: "advanceReadCursor", request: advanceRequest() },
              { label: "read-back", method: "getReadCursor", request: getRequest() },
              // §3 reference pointers, one per field.
              {
                label: "absent-workspace",
                method: "getReadCursor",
                request: getRequest({ workspace_name: "no-such-workspace" }),
              },
              { label: "absent-peer", method: "getReadCursor", request: getRequest({ peer_name: "no-such-peer" }) },
              {
                label: "absent-session",
                method: "getReadCursor",
                request: getRequest({ session_name: "no-such-session" }),
              },
              // §3: a message from ANOTHER session is not a valid desired pointer.
              {
                label: "wrong-session-message",
                method: "advanceReadCursor",
                request: advanceRequest({ last_read_message_id: IDS.otherSessionMessage, expected: null }),
              },
              {
                label: "absent-message",
                method: "advanceReadCursor",
                request: advanceRequest({ last_read_message_id: IDS.absentMessage, expected: null }),
              },
              // §3: cross-workspace peer identity confers nothing.
              {
                label: "cross-workspace",
                method: "getReadCursor",
                request: getRequest({ workspace_name: BETA }),
              },
            ],
          }),
        ],
        "references",
      );

      expect(okValue(events, "absent")).toBe(null);
      const created = okValue(events, "created") as { outcome?: string; row?: Record<string, unknown> };
      expect(created.outcome).toBe("created");
      // §2: exactly five columns, in physical order, pointer explicit, and the
      // timestamp is the pinned clock rendered as exact UTC-millisecond text —
      // authored here, never read back off the row under test.
      expect(Object.keys(created.row ?? {})).toEqual(ROW_FIELDS);
      expect(created.row).toEqual(cursorRow());
      expect(okValue(events, "read-back")).toEqual(cursorRow());

      expect(errorOf(events, "absent-workspace")).toEqual(
        pubError("invalid_reference", "/workspace_name", INVALID_REFERENCE),
      );
      expect(errorOf(events, "absent-peer")).toEqual(pubError("invalid_reference", "/peer_name", INVALID_REFERENCE));
      expect(errorOf(events, "absent-session")).toEqual(
        pubError("invalid_reference", "/session_name", INVALID_REFERENCE),
      );
      expect(errorOf(events, "wrong-session-message")).toEqual(
        pubError("invalid_reference", "/last_read_message_id", INVALID_REFERENCE),
      );
      expect(errorOf(events, "absent-message")).toEqual(
        pubError("invalid_reference", "/last_read_message_id", INVALID_REFERENCE),
      );
      // Beta exists but holds none of these names: a scoped miss, not a leak.
      expect(errorOf(events, "cross-workspace")).toEqual(
        pubError("invalid_reference", "/peer_name", INVALID_REFERENCE),
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the declared namespace is public_id only, and a legacy numeric id fails static grammar",
    async () => {
      const root = await seededDataset("namespace");
      const events = await runChildOk(
        root,
        [
          "cursor-ops",
          root,
          payloadFile("namespace", {
            // §4: none of these reaches a write, so the clock must never be sampled.
            clock_must_not_be_called: true,
            steps: [
              {
                label: "legacy-numeric",
                method: "advanceReadCursor",
                request: advanceRequest({ last_read_message_id: "42" }),
              },
              {
                label: "numeric-type",
                method: "advanceReadCursor",
                request: advanceRequest({ last_read_message_id: 42 }),
              },
            ],
          }),
        ],
        "namespace",
      );

      // Governed static grammar, closed on all five fields including the code:
      // `requireNanoid21` rejects the wrong-shape string "42" and the non-string
      // 42 identically, so both envelopes are the same accepted literal.
      for (const label of ["legacy-numeric", "numeric-type"] as const) {
        expect({ label, error: errorOf(events, label) }).toEqual({
          label,
          error: nanoidError("/last_read_message_id"),
        });
      }
      // §4: a request refused by static grammar never samples the clock.
      expect(events).not.toContain("clock:called");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an observer that never joined reads and records progress",
    async () => {
      // Control for the two staged cases below: membership was never created at
      // all, so any difference there is attributable to leaving or deactivation.
      const root = await seededDataset("history-control");
      const events = await runChildOk(
        root,
        [
          "cursor-ops",
          root,
          payloadFile("history-control", {
            steps: [
              { label: "advance", method: "advanceReadCursor", request: advanceRequest() },
              { label: "get", method: "getReadCursor", request: getRequest() },
            ],
          }),
        ],
        "history-control",
      );
      const advanced = okValue(events, "advance") as { outcome?: string; row?: Record<string, unknown> };
      expect(Object.keys(advanced.row ?? {})).toEqual(ROW_FIELDS);
      expect({ outcome: advanced.outcome, row: advanced.row }).toEqual({ outcome: "created", row: cursorRow() });
      expect(okValue(events, "get")).toEqual(cursorRow());
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an observer that joined and then LEFT still reads and records progress, while its appends stay refused",
    async () => {
      const root = await seededDataset("history-left");
      // The peer whose cursor is under test is the one that leaves — the author's
      // membership is irrelevant to the observer's progress.
      await joinObserver(root, "history-left");
      const membership = await stageRaw(
        root,
        "leave-membership",
        [ALPHA, NAMES.session, NAMES.observer],
        "history-left",
      );
      expect(membership.length).toBe(1);
      expect({
        workspace_name: membership[0]?.workspace_name,
        session_name: membership[0]?.session_name,
        peer_name: membership[0]?.peer_name,
        leftAtIsSet: membership[0]?.left_at !== null,
      }).toEqual({
        workspace_name: ALPHA,
        session_name: NAMES.session,
        peer_name: NAMES.observer,
        leftAtIsSet: true,
      });

      const events = await runChildOk(
        root,
        [
          "cursor-ops",
          root,
          payloadFile("history-left", {
            steps: [
              // Only membership varies here: the session must still be active, or
              // this case would not be isolated from the next one.
              { label: "session", method: "getSession", request: { workspace_name: ALPHA, session_name: NAMES.session } },
              { label: "advance", method: "advanceReadCursor", request: advanceRequest() },
              { label: "get", method: "getReadCursor", request: getRequest() },
              // §3: the policy difference is deliberate — appends still require
              // current membership, and that rule is untouched by this slice. The
              // SAME peer is used, so the contrast is membership, not identity.
              {
                label: "append-still-refused",
                method: "appendMessages",
                request: {
                  workspace_name: ALPHA,
                  session_name: NAMES.session,
                  items: [messageItem(id("rc-msg-late"), "after leaving", NAMES.observer)],
                },
              },
            ],
          }),
        ],
        "history-left",
      );

      expect((okValue(events, "session") as { is_active?: unknown }).is_active).toBe(true);
      const advanced = okValue(events, "advance") as { outcome?: string; row?: Record<string, unknown> };
      expect(Object.keys(advanced.row ?? {})).toEqual(ROW_FIELDS);
      expect({ outcome: advanced.outcome, row: advanced.row }).toEqual({ outcome: "created", row: cursorRow() });
      expect(okValue(events, "get")).toEqual(cursorRow());
      // Closed on the whole batch: `stopped` alone would also be satisfied by
      // any unrelated item failure, which would prove nothing about membership.
      // The pointer is this peer's own field, at this item's index.
      expect(okValue(events, "append-still-refused")).toEqual({
        outcome: "stopped",
        results: [],
        stop: { index: 0, error: wireError("invalid_reference", "/items/0/message/peer_name") },
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an INACTIVE session with membership intact still permits reading and recording progress",
    async () => {
      const root = await seededDataset("history-inactive");
      // Membership is current for this case; only session activity varies.
      await joinObserver(root, "history-inactive");
      const sessions = await stageRaw(root, "deactivate-session", [ALPHA, NAMES.session], "history-inactive");
      expect(sessions.length).toBe(1);
      expect(sessions[0]).toEqual({ workspace_name: ALPHA, name: NAMES.session, is_active: "false" });

      const events = await runChildOk(
        root,
        [
          "cursor-ops",
          root,
          payloadFile("history-inactive", {
            steps: [
              { label: "session", method: "getSession", request: { workspace_name: ALPHA, session_name: NAMES.session } },
              { label: "advance", method: "advanceReadCursor", request: advanceRequest() },
              { label: "get", method: "getReadCursor", request: getRequest() },
              // §3 again, by the OTHER route: membership is current here, so the
              // refusal must name the session, not the peer.
              {
                label: "append-still-refused",
                method: "appendMessages",
                request: {
                  workspace_name: ALPHA,
                  session_name: NAMES.session,
                  items: [messageItem(id("rc-msg-off"), "after deactivation", NAMES.observer)],
                },
              },
            ],
          }),
        ],
        "history-inactive",
      );

      // The staged premise, re-read through the accepted interface.
      expect((okValue(events, "session") as { is_active?: unknown }).is_active).toBe(false);
      const advanced = okValue(events, "advance") as { outcome?: string; row?: Record<string, unknown> };
      expect(Object.keys(advanced.row ?? {})).toEqual(ROW_FIELDS);
      expect({ outcome: advanced.outcome, row: advanced.row }).toEqual({ outcome: "created", row: cursorRow() });
      expect(okValue(events, "get")).toEqual(cursorRow());
      // The session gate runs before the item loop, so the pointer is the
      // request's own session field and no item was ever entered.
      expect(okValue(events, "append-still-refused")).toEqual({
        outcome: "stopped",
        results: [],
        stop: { index: 0, error: wireError("invalid_reference", "/session_name") },
      });
    },
    TEST_TIMEOUT_MS,
  );
});

// ── shared owner: queue, poison in both directions, one-shot close ───────────

describe.skipIf(!READY)(`shared owner lifecycle [${PENDING}]`, () => {
  /** One poisoned owner, parameterised by WHICH facade fails first. Everything
   *  else is held fixed: one gate, one queue, one poison state, one close. */
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
        // §5: the failure must come AFTER the row was attempted; a first
        // pre-write refusal is a different rule with a different code.
        throw_at: "after_write",
        hold_ms: 20_000,
        cursor_after_request: advanceRequest(),
        peer_request: { workspace_name: ALPHA, peer_id: id(`${label}-after`), name: `${label}-after` },
        get_request: getRequest(),
        ...payload,
      }),
    ]);
    const { readUntil, expectPoisoned, expectValue } = ownerReader(owner);
    try {
      expect(await readUntil("cursor:parked")).toBe("cursor:parked");
      // §1: cursor reads bypass the write queue, so this answers mid-write, and
      // it answers from BEFORE the parked write — nothing has been appended yet.
      await expectValue("parked:get", expected.parked);
      expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

      await expectPoisoned("write:first");
      await expectPoisoned("write:second");
      // Both directions on one owner: a cursor write and a context write.
      await expectPoisoned("cursor:write-after");
      await expectPoisoned("context:write-after");
      // §1: reads survive poison…
      await expectValue("poisoned:get", expected.poisoned);
      // …and where the poisoned write was a CONTEXT write, the row it attempted
      // is read back and compared field by field, so "attempted" means reached
      // the store rather than merely reached a hook label.
      if (expected.peer !== undefined) await expectValue("poisoned:peer-get", expected.peer);
      // …and fail only after release.
      await expectPoisoned("released:get");
      expect(await readUntil("owner:alive")).toBe("owner:alive");
    } finally {
      owner.kill();
      await owner.wait().catch(() => undefined);
    }
  };

  test(
    "a poisoned cursor write leaves the attempted row readable, and blocks a queued context write",
    async () => {
      const root = await seededDataset("poison-cursor");
      await poisonedOwner(
        "poison-cursor",
        root,
        {
          first_method: "advanceReadCursor",
          first_request: advanceRequest(),
          second_method: "registerPeer",
          second_request: { workspace_name: ALPHA, peer_id: id("rc-peer-3"), name: "rc-third" },
        },
        {
          parked: null,
          // §5: the hook threw AFTER the append, so the row IS on disk. Poison is
          // fail-stop, not rollback, and the row asserted here is authored from
          // the request and the pinned clock — never echoed back from the write.
          poisoned: cursorRow(),
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a poisoned CONTEXT write blocks a queued cursor write, and the cursor stays absent",
    async () => {
      const root = await seededDataset("poison-context");
      await poisonedOwner(
        "poison-context",
        root,
        {
          // The other direction: the failing write is a context write, and the
          // write it blocks is the cursor write behind it on the same queue.
          first_method: "registerPeer",
          first_request: { workspace_name: ALPHA, peer_id: id("rc-peer-5"), name: "rc-fifth" },
          second_method: "advanceReadCursor",
          second_request: advanceRequest(),
          peer_get_request: { workspace_name: ALPHA, peer_name: "rc-fifth" },
        },
        {
          parked: null,
          // The queued cursor write never ran, so no cursor row was ever
          // attempted: the read still answers, and it answers null.
          poisoned: null,
          // The peer write DID land before its boundary threw — same fail-stop,
          // not-a-rollback rule as the cursor direction.
          peer: peerRow(id("rc-peer-5"), "rc-fifth"),
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a context writer excludes every other factory and spelling, and close is one-shot",
    async () => {
      const root = await freshDataset("cross-factory");
      const alias = join(scratch, "cursor-alias");
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
          { deadlineMs: 30_000 },
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
