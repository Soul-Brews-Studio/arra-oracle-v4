// #28 session-link OWNERSHIP evidence -- four context-bearing facades, the
// closed method lists, shared queue/poison in BOTH directions, reads that
// bypass the write queue, and one-shot close.
//
// Authority is `app/docs/contracts/session-link-v1.md`, whose final "Ownership"
// section states in so many words that the ownership, recovery and precision
// lanes were NOT delivered by the first pass. This file and
// `session-link-recovery.test.ts` are that gap being filled; the precision lane
// (Int64 boundary sweep, cursor/page-edge arithmetic) is still NOT delivered
// and is not claimed here.
//
// Division of labour, so nothing is counted twice: method semantics, grammar,
// cycle policy, evidence-ref codec and the boundary/clock discipline for
// replay/conflict/read belong to `session-link-service.test.ts`; crash, real
// SDK failure and fresh-owner convergence to `session-link-recovery.test.ts`.
// Neither is duplicated here.
//
// Every expected value is authored HERE: facade key sets, the nine runtime
// exports, the two closed method lists, the session-link row, the peer row and
// every error envelope. Requests are built in this file rather than taken from
// `helpers/session-link-fixture.ts`, so no builder can define its own
// expectations; the shared helper is used only for the DATASET and for the
// pure nanoid21 padding function, neither of which carries an expectation.
//
// HOW THE METHOD LISTS WERE OBTAINED (this matters more than the numbers):
// they were read off `src/publication/service.ts` in this worktree --
// `createContextReadMethods` returns eleven methods and
// `createContextWriterService` returns `{...reads}` plus eleven of its own, so
// the writer union is twenty-two. They were then compared against the accepted
// read-cursor lane's literals and found identical, which is the expected
// outcome: this slice adds methods to the existing context reader/writer and
// no new factory or bundle key, exactly as the contract's "Boundaries reused
// unchanged" section requires.
//
// Bounded claims: one cooperative local gate, disposable fixtures, pinned Bun
// and Python on Darwin. The gate is an operator protocol, not a CAS, and
// nothing here defends against same-UID code that imports the SDK and declines
// to take it. Boundary hooks prove COMMANDED ordering, not real SDK failure --
// the recovery lane owns that. Nothing here speaks to Linux, NFS, R2,
// multiwriter, or power loss, and nothing here speaks to admission: a peer name
// in a request is not authorization.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PYTHON, runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";
import { createSessionLinkFixture, sessionLinkId } from "./helpers/session-link-fixture";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OWNERSHIP_CHILD = join(TEST_DIR, "fixtures", "session-link-v1", "ownership", "link-child.ts");
const TEST_TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

// -- independent oracles, authored from the contract --------------------------

/** The runtime export set stays at the accepted nine: this slice adds methods,
 *  never a factory. */
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
/** Twenty-two on every context WRITER facade (its own eleven plus the eleven
 *  reader methods it spreads in), eleven on every context READER facade. */
// #30 overnight R7/R8: `getSearchFreshness` (read) and `embedPendingChunks`
// (write-only) join the context facade -- both lists below grew accordingly.
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,answerChat,appendMessages,createSessionLink,createTrace," +
  "embedPendingChunks,getContext,getMessage,getPeer,getReadCursor,getRecallEligibility," +
  "getSearchFreshness,getSession,getTrace," +
  "indexRevisionChunks,joinSession,listConnections,listLifecycleHistory,listMcpCalls," +
  "listMessages,listPeers,listSearchChunks,listSessionLinks,listSessions,listTraceHits," +
  "reconcileSearchChunks,registerPeer,registerSession,retireNode,supersedeNode," +
  "writeChunkEmbedding";
const CONTEXT_READ_METHODS =
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSearchFreshness," +
  "getSession,getTrace," +
  "listConnections,listLifecycleHistory,listMcpCalls,listMessages,listPeers," +
  "listSearchChunks,listSessionLinks,listSessions,listTraceHits";
/** Bundle keys are unchanged by this slice; nested facades never carry close. */
const CONTEXT_WRITER_KEYS = "close,context,publication,taxonomy";
const EVIDENCE_WRITER_KEYS = "close,context,evidence,publication,taxonomy";
const CONTEXT_READER_KEYS = "context,publication,taxonomy";
const EVIDENCE_READER_KEYS = "context,evidence,publication,taxonomy";

/** The eight physical columns, in exact order. */
const ROW_FIELDS = [
  "id",
  "workspace_name",
  "from_session_name",
  "to_session_name",
  "relation",
  "evidence_ref",
  "created_by_peer_name",
  "created_at",
];
/** The clock this file pins for every write, and the exact UTC-millisecond text
 *  it must render. Asserting this literal -- rather than echoing the row the
 *  write returned -- is what makes the row an oracle instead of a self-report. */
const CLOCK_MS = 1_789_905_600_000;
const CLOCK_TEXT = "2026-09-20T12:00:00.000Z";

const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);
const IDS = {
  sessionA: id("sl-sess-a"),
  sessionB: id("sl-sess-b"),
  link: id("sl-link-1"),
  linkAfter: id("sl-link-2"),
};
const NAMES = {
  sessionA: "sl-session-alpha",
  sessionB: "sl-session-beta",
};

/** Requests, in the contract's exact closed grammar, authored here. */
const createRequest = (overrides: Record<string, unknown> = {}) => ({
  id: IDS.link,
  workspace_name: ALPHA,
  from_session_name: NAMES.sessionA,
  to_session_name: NAMES.sessionB,
  relation: "continues",
  evidence_ref: null,
  created_by_peer_name: null,
  ...overrides,
});
const listRequest = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  session_name: NAMES.sessionA,
  direction: "from",
  cursor: null,
  limit: 10,
  ...overrides,
});
/** The complete row the create in this file must produce, authored here. */
const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: IDS.link,
  workspace_name: ALPHA,
  from_session_name: NAMES.sessionA,
  to_session_name: NAMES.sessionB,
  relation: "continues",
  evidence_ref: null,
  created_by_peer_name: null,
  created_at: CLOCK_TEXT,
  ...overrides,
});
/** A registered peer row, authored here from the request and the pinned clock.
 *  Used to prove a poisoned CONTEXT write really reached the store. */
const peerRow = (peerId: string, peerName: string) => ({
  id: peerId,
  name: peerName,
  workspace_name: ALPHA,
  h_metadata: null,
  internal_metadata: null,
  configuration: null,
  created_at: CLOCK_TEXT,
});

/** Error envelopes and the publication literals this slice may emit. */
const pubError = (code: string, path: string, message: string) => ({
  name: "PublicationError",
  version: "arra-publication-error/v1",
  code,
  path,
  message,
});
const RECOVERY_REQUIRED = "writer recovery required";

// -- preflight, in this process ----------------------------------------------

// No catch: a module that cannot load is a real failure and must say so here,
// never a silent skip.
const service = (await import(join(SERVER_DIR, "src", "publication", "service.ts"))) as Record<string, unknown>;

test("preflight: the runtime export set is exactly the accepted nine", () => {
  // Measured in THIS process against the module namespace; the gated children
  // below re-measure it from inside a real owner, so a divergence between the
  // two would itself show up.
  expect(Object.keys(service).sort().join(",")).toBe(RUNTIME_EXPORTS);
});

// -- scratch ------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-session-link-ownership-"));
const cleanups: { label: string; run: () => Promise<void> }[] = [];

async function freshDataset(label: string): Promise<string> {
  const fixture = await createSessionLinkFixture([ALPHA, BETA]);
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

/** Two real sessions, registered through the REAL context API in their own
 *  gated pass, so the links below point at rows the service itself wrote. */
async function seededDataset(label: string): Promise<string> {
  const root = await freshDataset(label);
  const events = await runChildOk(
    root,
    [
      "setup",
      root,
      payloadFile(`${label}-setup`, {
        setup_methods: { session_a: "registerSession", session_b: "registerSession" },
        setup: {
          session_a: { workspace_name: ALPHA, session_id: IDS.sessionA, name: NAMES.sessionA },
          session_b: { workspace_name: ALPHA, session_id: IDS.sessionB, name: NAMES.sessionB },
        },
      }),
    ],
    `${label}-setup`,
  );
  // Setup identities are asserted, not assumed: a link aimed at a session this
  // file never created would refuse for the wrong reason.
  for (const step of ["session_a", "session_b"]) {
    expect({ step, outcome: (okValue(events, `setup:${step}`) as { outcome?: string }).outcome }).toEqual({
      step,
      outcome: "created",
    });
  }
  // No peer is registered here ON PURPOSE: decision 2 admits endpoints by
  // EXISTENCE ONLY and decision 6 makes `created_by_peer_name` a stored fact,
  // so a session link needs no peer at all. The poison cases below use
  // `registerPeer` precisely because it is an unrelated context write.
  return root;
}

afterAll(async () => {
  const failures: string[] = [];
  for (const { label, run } of cleanups) {
    await run().catch((error: unknown) => failures.push(`${label}: ${String(error)}`));
  }
  rmSync(scratch, { recursive: true, force: true });
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

// -- four context-bearing facades ---------------------------------------------

describe("context facades across all four factories", () => {
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
        // Nested facades never carry close, and every context member is callable.
        expect(eventFor(events, `writer:${factory}:valuetypes`)).toBe(`writer:${factory}:valuetypes function`);
        // The runtime export set does not grow with facade methods.
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

      // Said once more in the terms of THIS slice, from the same observed
      // lists: both session-link methods are on every writer facade, the READ
      // method is on every reader facade, and the WRITE method is on none of
      // them. The closed lists above already decide this; spelling it out means
      // a future edit that moves `createSessionLink` onto the reader fails with
      // a message that names the actual mistake.
      const writerMethods = CONTEXT_WRITE_METHODS.split(",");
      const readerMethods = CONTEXT_READ_METHODS.split(",");
      expect(writerMethods).toContain("createSessionLink");
      expect(writerMethods).toContain("listSessionLinks");
      expect(readerMethods).toContain("listSessionLinks");
      expect(readerMethods).not.toContain("createSessionLink");
      // #30 overnight R7/R8 added embedPendingChunks (write-only) and
      // getSearchFreshness (read+write): 29 -> 31 and 16 -> 17.
      expect({ writer: writerMethods.length, reader: readerMethods.length }).toEqual({ writer: 31, reader: 17 });
      expect(writerMethods).not.toContain("close");
      expect(readerMethods).not.toContain("close");
    },
    TEST_TIMEOUT_MS,
  );
});

// -- shared owner: queue, poison in both directions, one-shot close -----------

describe("shared owner lifecycle", () => {
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
        // The failure must come AFTER the row was attempted; a first pre-write
        // refusal is a different rule with a different code, and the recovery
        // lane measures that one.
        throw_at: "after_write",
        hold_ms: 20_000,
        link_after_request: createRequest({ id: IDS.linkAfter }),
        peer_request: { workspace_name: ALPHA, peer_id: id(`${label}-aft`), name: `${label}-after` },
        list_request: listRequest(),
        ...payload,
      }),
    ]);
    const { readUntil, expectPoisoned, expectValue } = ownerReader(owner);
    try {
      expect(await readUntil("link:parked")).toBe("link:parked");
      // Session-link reads bypass the write queue, so this answers mid-write,
      // and it answers from BEFORE the parked write -- nothing is appended yet.
      await expectValue("parked:list", expected.parked);
      expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

      await expectPoisoned("write:first");
      await expectPoisoned("write:second");
      // Both directions on one owner: a session-link write and a context write.
      await expectPoisoned("link:write-after");
      await expectPoisoned("context:write-after");
      // Reads survive poison...
      await expectValue("poisoned:list", expected.poisoned);
      // ...and where the poisoned write was a CONTEXT write, the row it
      // attempted is read back and compared field by field, so "attempted"
      // means reached the store rather than merely reached a hook label.
      if (expected.peer !== undefined) await expectValue("poisoned:peer-get", expected.peer);
      // ...and fail only after release.
      await expectPoisoned("released:list");
      expect(await readUntil("owner:alive")).toBe("owner:alive");
    } finally {
      owner.kill();
      await owner.wait().catch(() => undefined);
    }
  };

  test(
    "a poisoned session-link write leaves the attempted row readable, and blocks a queued context write",
    async () => {
      const root = await seededDataset("poison-link");
      await poisonedOwner(
        "poison-link",
        root,
        {
          first_method: "createSessionLink",
          first_request: createRequest(),
          second_method: "registerPeer",
          second_request: { workspace_name: ALPHA, peer_id: id("sl-peer-3"), name: "sl-third" },
        },
        {
          parked: { rows: [], next_cursor: null },
          // The hook threw AFTER the append, so the row IS on disk. Poison is
          // fail-stop, not rollback, and the row asserted here is authored from
          // the request and the pinned clock -- never echoed back from the write.
          poisoned: { rows: [linkRow()], next_cursor: null },
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a poisoned CONTEXT write blocks a queued session-link write, and no link row is created",
    async () => {
      const root = await seededDataset("poison-context");
      await poisonedOwner(
        "poison-context",
        root,
        {
          // The other direction: the failing write is a context write, and the
          // write it blocks is the session-link write behind it on the same
          // queue.
          first_method: "registerPeer",
          first_request: { workspace_name: ALPHA, peer_id: id("sl-peer-5"), name: "sl-fifth" },
          second_method: "createSessionLink",
          second_request: createRequest(),
          peer_get_request: { workspace_name: ALPHA, peer_name: "sl-fifth" },
        },
        {
          parked: { rows: [], next_cursor: null },
          // The queued session-link write never ran, so no link row was ever
          // attempted: the read still answers, and it answers an empty page.
          poisoned: { rows: [], next_cursor: null },
          // The peer write DID land before its boundary threw -- same fail-stop,
          // not-a-rollback rule as the session-link direction.
          peer: peerRow(id("sl-peer-5"), "sl-fifth"),
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a context writer excludes every other factory and spelling, and close is one-shot",
    async () => {
      const root = await freshDataset("cross-factory");
      const alias = join(scratch, "session-link-alias");
      symlinkSync(root, alias);
      const owner = spawnGatedChild(root, OWNERSHIP_CHILD, [
        "cross-factory",
        root,
        payloadFile("cross-factory", { alias, hold_ms: 20_000 }),
      ]);
      const { readUntil } = ownerReader(owner);

      try {
        expect(await readUntil("owner:context")).toBe("owner:context ready");
        // A second context writer, a second EVIDENCE writer (a different
        // factory over the same root), and the same root spelled through a
        // symlink: all three are the same owner, and all three are refused.
        for (const label of ["second:context", "second:evidence", "second:alias"]) {
          expect(await readUntil(label)).toBe(`${label} writer_unavailable`);
        }
        expect(await readUntil("close:same-promise")).toBe("close:same-promise true");
        expect(await readUntil("close:resolved")).toBe("close:resolved");
        expect(await readUntil("reopen:after-close")).toBe("reopen:after-close writer_unavailable");
        expect(await readUntil("owner:alive")).toBe("owner:alive");

        // Close released the inherited descriptor: an unrelated process can now
        // take the real gate. Measured, not inferred from the absence of an
        // error.
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

// -- the row shape this file asserts against, stated once ---------------------

test("the authored row this file compares against carries the eight physical columns in order", () => {
  // A guard on the ORACLE, not on the product: if this file's own authored row
  // ever drifts from the physical schema, every comparison above would still
  // "pass" against a weaker shape.
  expect(Object.keys(linkRow())).toEqual(ROW_FIELDS);
  expect(sessionLinkId("sl-link-1")).toHaveLength(21);
});
