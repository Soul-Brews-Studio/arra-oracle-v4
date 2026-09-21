// #60 context ownership evidence — registration, scoped references, replay
// collision and destination precedence, membership policy, read history, shared
// queue/poison/close and surface exactness. Refs #60, Parent #28.
//
// Authority is `app/docs/contracts/context-ingestion-v1.md`
// (SHA256 9c3c1a0fd41f43b7867dd76530e6294b13a1f85ad9ea8cf053101dfc5923ece5), §9 OWNERSHIP.
// Batch durability, lost-ACK and real SDK-failure evidence belong to
// `context-recovery.test.ts`; ordered allocation, wire precision and pagination edges to
// `fixtures/context-v1/precision.test.ts`. This file does not duplicate either oracle.
//
// Every expected value — facade key sets, outcomes, conflict reasons, error name, version,
// code and path — is authored HERE from the contract. The published builders are used only
// to encode requests; the identities, names and expectations are this file's own, so a
// builder defect cannot define its own assertions.
//
// Errors are asserted as name AND version AND code AND path. The code alone is identical
// across the governed and publication envelopes, which is exactly how an envelope defect
// survived two lanes in #47.
//
// Dependency status: `openContextWriter`/`openContextReader` (#59 core) and
// `helpers/context-fixture.ts` are ABSENT at the time of writing. Suites needing them skip
// with the blocker named in the title; a missing module proves absence, never behaviour, and
// no skip is ever credited as evidence.
//
// Bounded claims: one cooperative local gate, disposable datasets from the frozen bare
// taxonomy fixture, pinned Bun and Python on Darwin. Boundary hooks prove commanded ordering,
// not real SDK failure. Nothing here speaks to Linux, NFS, R2, multiwriter CAS or power loss.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PYTHON, runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OWNERSHIP_CHILD = join(TEST_DIR, "fixtures", "context-v1", "ownership", "context-child.ts");
const RAW_MUTATE = join(TEST_DIR, "fixtures", "context-v1", "ownership", "raw-mutate.ts");
/** Trusted operator configuration for the sourced writer instance, never request data. */
const SOURCE_NAMESPACE = "ownership-probe";
const TEST_TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

// ── independent oracles, authored from the contract ──────────────────────────

/** §1: writer {publication,taxonomy,context,close}; reader {publication,taxonomy,context}. */
const WRITER_KEYS = "close,context,publication,taxonomy";
const READER_KEYS = "context,publication,taxonomy";
/** §8: context writer has exactly these twenty-two (its own eleven plus the
 *  eleven reader methods it spreads in); the reader exactly the eleven. */
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,answerChat,appendMessages,createSessionLink,createTrace,getContext,getMessage," +
  "getPeer,getReadCursor,getRecallEligibility,getSession,getTrace,indexRevisionChunks,joinSession," +
  "listLifecycleHistory,listMessages,listSearchChunks,listSessionLinks,listTraceHits," +
  "reconcileSearchChunks,registerPeer,registerSession,retireNode,supersedeNode,writeChunkEmbedding";
const CONTEXT_READ_METHODS =
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "listLifecycleHistory,listMessages,listSearchChunks,listSessionLinks,listTraceHits";
/** Existing facades keep their exact key sets and carry no close. */
const PUBLICATION_WRITE_METHODS = "getAcceptedHead,listAcceptedHistory,publishRevision";
const PUBLICATION_READ_METHODS = "getAcceptedHead,listAcceptedHistory";
const TAXONOMY_WRITE_METHODS =
  "createTerm,createVocabulary,getTerm,getVocabulary,renameTerm,reparentTerm,retireTerm,seedReservedVocabularies";
const TAXONOMY_READ_METHODS = "getTerm,getVocabulary";

/** §6: persistence/reference/state failures reuse the publication envelope, unchanged. */
const PUB_ERR = "PublicationError arra-publication-error/v1";

/** Identities supplied by this file, never by a builder. */
const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);
const IDS = {
  peer: id("ctx-peer-1"),
  spare_peer: id("ctx-peer-2"),
  session: id("ctx-session-1"),
  spare_session: id("ctx-session-2"),
  vocabulary: id("ctx-voc-1"),
  node: id("ctx-node-1"),
};
const NAMES = {
  peer: "ctx-author",
  other_peer: "ctx-observer",
  session: "ctx-session-alpha",
  other_session: "ctx-session-beta",
};

/**
 * Request bodies are built here rather than through the shared builders: the
 * identities and payloads are this file's oracle, so a builder change cannot
 * silently move what is being asserted. Shapes follow §2 exactly, including the
 * source key names the codec actually accepts.
 */
const messageItem = (publicId: string, content: string): Record<string, unknown> => ({
  public_id: publicId,
  message: { peer_name: NAMES.peer, role: null, content, in_reply_to: null },
  source: null,
});
const sourcedItem = (publicId: string, content: string, sourceMessageId: string): Record<string, unknown> => ({
  public_id: publicId,
  message: { peer_name: NAMES.peer, role: null, content, in_reply_to: null },
  source: { source_message_id: sourceMessageId, source_created_at: null, supplied_digest: null },
});
const appendRequest = (session: string, items: Record<string, unknown>[]): Record<string, unknown> => ({
  workspace_name: ALPHA,
  session_name: session,
  items,
});

// ── dependency probes ────────────────────────────────────────────────────────

const service = (await import(join(SERVER_DIR, "src", "publication", "service.ts")).catch(() => ({}))) as Record<
  string,
  unknown
>;
const contextHelper = (await import(join(TEST_DIR, "helpers", "context-fixture.ts")).catch(() => null)) as {
  createContextFixture?: (workspaces?: string[]) => Promise<{
    datasetRoot: string;
    workspaces: Record<string, { workspace_id: string }>;
    cleanup: () => Promise<void>;
  }>;
} | null;

const ENTRY_READY =
  typeof service.openContextWriter === "function" && typeof service.openContextReader === "function";
const FIXTURE_READY = typeof contextHelper?.createContextFixture === "function";
const READY = ENTRY_READY && FIXTURE_READY;
const PENDING = [
  ENTRY_READY ? null : "openContextWriter/openContextReader (#59)",
  FIXTURE_READY ? null : "helpers/context-fixture.ts (#59)",
]
  .filter(Boolean)
  .join(" + ");

// ── scratch ──────────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-context-ownership-"));
const cleanups: (() => Promise<void>)[] = [];

async function freshDataset(): Promise<string> {
  const fixture = await contextHelper!.createContextFixture!([ALPHA, BETA]);
  cleanups.push(fixture.cleanup);
  return fixture.datasetRoot;
}

function payloadFile(name: string, value: Record<string, unknown>): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify({ workspace: ALPHA, ids: IDS, names: NAMES, ...value }), { mode: 0o600 });
  return path;
}

const eventsOf = (stdout: string): string[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => line.slice("EVENT ".length).trim());

/** Decode a structured batch result; never substring-match a serialized envelope. */
type BatchResult = {
  outcome: string;
  results: { index: number; outcome: string; public_id: string | null }[];
  stop: null | { index: number; error?: Record<string, unknown>; conflict?: string };
};
const batchOf = (events: string[], label: string): BatchResult => {
  const line = events.find((event) => event.startsWith(`batch-json:${label} `));
  if (line === undefined) throw new Error(`no batch result for ${label}; saw ${JSON.stringify(events)}`);
  return JSON.parse(line.slice(`batch-json:${label} `.length)) as BatchResult;
};
/** §6 messages are fixed literals; the envelope is compared whole, including them. */
const pubError = (code: string, path: string, message: string) => ({
  version: "arra-publication-error/v1",
  code,
  path,
  message,
});

const eventFor = (events: string[], name: string): string =>
  events.find((event) => event === name || event.startsWith(`${name} `)) ??
  `MISSING ${name} (saw ${JSON.stringify(events)})`;

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
});

// ── surface exactness ────────────────────────────────────────────────────────

describe.skipIf(!READY)(`context composition surfaces [${PENDING}]`, () => {
  test(
    "the writer exposes exactly four keys, the reader three, and every nested facade its contracted methods",
    async () => {
      const root = await freshDataset();
      const run = await runGated(root, OWNERSHIP_CHILD, ["surfaces", root, payloadFile("surfaces", {})]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "writer:keys")).toBe(`writer:keys ${WRITER_KEYS}`);
      // Existing facades keep their exact shapes: no close appears on either.
      expect(eventFor(events, "writer:publication")).toBe(`writer:publication ${PUBLICATION_WRITE_METHODS}`);
      expect(eventFor(events, "writer:taxonomy")).toBe(`writer:taxonomy ${TAXONOMY_WRITE_METHODS}`);
      expect(eventFor(events, "writer:context")).toBe(`writer:context ${CONTEXT_WRITE_METHODS}`);
      expect(eventFor(events, "writer:valuetypes")).toBe("writer:valuetypes function");
      expect(eventFor(events, "writer:prototype")).toBe("writer:prototype true");

      expect(eventFor(events, "reader:keys")).toBe(`reader:keys ${READER_KEYS}`);
      expect(eventFor(events, "reader:publication")).toBe(`reader:publication ${PUBLICATION_READ_METHODS}`);
      expect(eventFor(events, "reader:taxonomy")).toBe(`reader:taxonomy ${TAXONOMY_READ_METHODS}`);
      expect(eventFor(events, "reader:context")).toBe(`reader:context ${CONTEXT_READ_METHODS}`);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── registration, scoped references, membership policy ───────────────────────

describe.skipIf(!READY)(`registration and membership policy [${PENDING}]`, () => {
  test(
    "identity and name claims resolve per §3, and a missing scoped reference names its own pointer",
    async () => {
      const root = await freshDataset();
      const run = await runGated(root, OWNERSHIP_CHILD, ["registration", root, payloadFile("registration", {})]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "peer:new")).toBe("peer:new created");
      // A replay retains the original row and timestamp; it is not a second write.
      expect(eventFor(events, "peer:replay")).toBe("peer:replay already_satisfied");
      // Same ID carrying a different name conflicts at the ID; a different ID
      // claiming a held name conflicts at the name. Peers are never merged.
      expect(eventFor(events, "peer:same-id-new-name")).toBe("peer:same-id-new-name conflict:id");
      expect(eventFor(events, "peer:new-id-held-name")).toBe("peer:new-id-held-name conflict:name");
      expect(eventFor(events, "peer:absent-workspace")).toBe(
        `peer:absent-workspace ${PUB_ERR} invalid_reference /workspace_name`,
      );

      expect(eventFor(events, "session:new")).toBe("session:new created");
      expect(eventFor(events, "session:replay")).toBe("session:replay already_satisfied");
      expect(eventFor(events, "session:new-id-held-name")).toBe("session:new-id-held-name conflict:name");

      expect(eventFor(events, "join:new")).toBe("join:new created");
      expect(eventFor(events, "join:replay")).toBe("join:replay already_satisfied");
      expect(eventFor(events, "join:absent-session")).toBe(
        `join:absent-session ${PUB_ERR} invalid_reference /session_name`,
      );
      expect(eventFor(events, "join:absent-peer")).toBe(`join:absent-peer ${PUB_ERR} invalid_reference /peer_name`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a left membership conflicts terminally, refuses new messages, and keeps history readable",
    async () => {
      const root = await freshDataset();
      await runGated(root, OWNERSHIP_CHILD, [
        "membership-setup",
        root,
        payloadFile("left-setup", { seed_batch: appendRequest(NAMES.session, [messageItem(id("ctx-msg-left"), "kept")]) }),
      ]);
      // Nothing in this slice sets left_at, by design, so the state is staged with
      // my own gated raw connection — setup, never an oracle.
      const staged = await runGated(root, RAW_MUTATE, ["leave-membership", root, ALPHA, NAMES.session, NAMES.peer]);
      expect(eventsOf(staged.stdout).some((event) => event.startsWith("raw:left rows="))).toBe(true);

      const run = await runGated(root, OWNERSHIP_CHILD, [
        "membership-after",
        root,
        payloadFile("left-after", {
          append_request: appendRequest(NAMES.session, [messageItem(id("ctx-msg-after"), "refused")]),
        }),
      ]);
      const events = eventsOf(run.stdout);

      // §3: rejoin is outside this slice and the conflict is terminal.
      expect(eventFor(events, "after:join")).toBe("after:join conflict:membership");
      // §8: a new append needs CURRENT active membership; the refusal names a request pointer.
      // §5/§6: an admitted item's refusal is a STOPPED batch result whose stop is
      // the exact closed object — index plus the exact toJSON, with no name.
      expect(batchOf(events, "after:append")).toEqual({
        outcome: "stopped",
        results: [],
        stop: {
          index: 0,
          error: pubError("invalid_reference", "/items/0/message/peer_name", "invalid scoped reference"),
        },
      });
      // §8: left status never erases readable history.
      expect(eventFor(events, "after:get-session")).toBe("after:get-session row");
      expect(eventFor(events, "after:list")).toBe("after:list rows=1 next=null");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an inactive session is never reactivated by registration, refuses writes, and stays readable",
    async () => {
      const root = await freshDataset();
      await runGated(root, OWNERSHIP_CHILD, [
        "membership-setup",
        root,
        payloadFile("inactive-setup", { seed_batch: appendRequest(NAMES.session, [messageItem(id("ctx-msg-live"), "kept")]) }),
      ]);
      const staged = await runGated(root, RAW_MUTATE, ["deactivate-session", root, ALPHA, NAMES.session]);
      expect(eventsOf(staged.stdout).some((event) => event.startsWith("raw:deactivated rows="))).toBe(true);

      const run = await runGated(root, OWNERSHIP_CHILD, [
        "membership-after",
        root,
        payloadFile("inactive-after", {
          append_request: appendRequest(NAMES.session, [messageItem(id("ctx-msg-dead"), "refused")]),
        }),
      ]);
      const events = eventsOf(run.stdout);

      // §3: an already-present inactive session registers as satisfied, never reactivated.
      expect(eventFor(events, "after:register-session")).toBe("after:register-session already_satisfied");
      // §3/§8: join and append need an ACTIVE session; both name /session_name.
      expect(eventFor(events, "after:join")).toBe(`after:join ${PUB_ERR} invalid_reference /session_name`);
      expect(batchOf(events, "after:append")).toEqual({
        outcome: "stopped",
        results: [],
        stop: { index: 0, error: pubError("invalid_reference", "/session_name", "invalid scoped reference") },
      });
      // §8: reads do not require active status.
      expect(eventFor(events, "after:get-session")).toBe("after:get-session row");
      expect(eventFor(events, "after:list")).toBe("after:list rows=1 next=null");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── replay collision and destination precedence ──────────────────────────────

describe.skipIf(!READY)(`local and sourced collision precedence [${PENDING}]`, () => {
  test(
    "a local replay into another session is scope_mismatch before any immutable-state comparison",
    async () => {
      const root = await freshDataset();
      const shared = id("ctx-msg-shared");
      const run = await runGated(root, OWNERSHIP_CHILD, [
        "collision-local",
        root,
        payloadFile("collision-local", {
          batches: {
            first: appendRequest(NAMES.session, [messageItem(shared, "original")]),
            // Same public_id, different destination session, identical payload: the
            // destination decides, so immutable state is never reached.
            wrong_session: appendRequest(NAMES.other_session, [messageItem(shared, "original")]),
            // Same session, same id, changed content: this one IS an immutable mismatch.
            changed_payload: appendRequest(NAMES.session, [messageItem(shared, "edited")]),
            replay: appendRequest(NAMES.session, [messageItem(shared, "original")]),
          },
        }),
      ]);
      const events = eventsOf(run.stdout);

      expect(batchOf(events, "first")).toEqual({
        outcome: "complete",
        results: [{ index: 0, outcome: "accepted", public_id: shared }],
        stop: null,
      });
      // §5: an admitted item's rejection is a STOPPED RESULT, not a thrown
      // rejection; §6: stop.error is the governed toJSON, no name, and the
      // service-observed row is re-anchored beneath the item pointer.
      expect(batchOf(events, "wrong_session")).toEqual({
        outcome: "stopped",
        results: [],
        stop: {
          index: 0,
          error: {
            version: "arra-error/v1",
            code: "scope_mismatch",
            path: "/items/0/existing/session_name",
            message: "existing message is in a different session",
          },
        },
      });
      // A changed payload on the same destination is the immutable-state case.
      expect(batchOf(events, "changed_payload")).toEqual({
        outcome: "stopped",
        results: [],
        stop: { index: 0, conflict: "public_id" },
      });
      expect(batchOf(events, "replay")).toEqual({
        outcome: "complete",
        results: [{ index: 0, outcome: "idempotent", public_id: shared }],
        stop: null,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sourced replay is anchored to its source tuple, not to the proposed public_id",
    async () => {
      const root = await freshDataset();
      const first = id("ctx-src-a");
      const alternate = id("ctx-src-b");
      const second = id("ctx-src-c");
      const run = await runGated(root, OWNERSHIP_CHILD, [
        "collision-sourced",
        root,
        payloadFile("collision-sourced", {
          source_namespace: SOURCE_NAMESPACE,
          batches: {
            accepted: appendRequest(NAMES.session, [sourcedItem(first, "from-source", "source-msg-1")]),
            // The SAME source message aimed at another session: §4 compares
            // destination before digest, and §6 keeps the governed envelope.
            wrong_session: appendRequest(NAMES.other_session, [sourcedItem(first, "from-source", "source-msg-1")]),
            // A different, unoccupied proposal for the SAME source message: ignored,
            // and the original public_id comes back.
            alternate_proposal: appendRequest(NAMES.session, [sourcedItem(alternate, "from-source", "source-msg-1")]),
            // A NEW source message proposing an id another row already holds.
            occupied_proposal: appendRequest(NAMES.session, [sourcedItem(first, "different", "source-msg-2")]),
            // Same source message, changed payload.
            changed_payload: appendRequest(NAMES.session, [sourcedItem(second, "edited", "source-msg-1")]),
          },
        }),
      ]);
      const events = eventsOf(run.stdout);

      expect(batchOf(events, "accepted")).toEqual({
        outcome: "complete",
        results: [{ index: 0, outcome: "accepted", public_id: first }],
        stop: null,
      });
      // The decisive half of the shared scope_mismatch helper: on the SOURCED
      // path the accepted codec's own message must survive, with only the path
      // re-anchored beneath the item pointer.
      expect(batchOf(events, "wrong_session")).toEqual({
        outcome: "stopped",
        results: [],
        stop: {
          index: 0,
          error: {
            version: "arra-error/v1",
            code: "scope_mismatch",
            path: "/items/0/existing/session_name",
            message: "existing message is in a different session",
          },
        },
      });
      // §2: the alternate proposal is ignored and the ORIGINAL id comes back.
      expect(batchOf(events, "alternate_proposal")).toEqual({
        outcome: "complete",
        results: [{ index: 0, outcome: "idempotent", public_id: first }],
        stop: null,
      });
      // §8: source absent but the proposed id is held by another row.
      expect(batchOf(events, "occupied_proposal")).toEqual({
        outcome: "stopped",
        results: [],
        stop: { index: 0, conflict: "public_id" },
      });
      // §4: changed payload for an existing source tuple.
      expect(batchOf(events, "changed_payload")).toEqual({
        outcome: "stopped",
        results: [],
        stop: { index: 0, conflict: "source_payload" },
      });
    },
    TEST_TIMEOUT_MS,
  );
});

// ── read history ────────────────────────────────────────────────────────────

describe.skipIf(!READY)(`scoped reads and history [${PENDING}]`, () => {
  test(
    "absent scoped identities read as null, a missing workspace or session names its pointer",
    async () => {
      const root = await freshDataset();
      // Registration first, so the reads below have something real to find.
      await runGated(root, OWNERSHIP_CHILD, ["registration", root, payloadFile("read-setup", {})]);
      const run = await runGated(root, OWNERSHIP_CHILD, [
        "read-history",
        root,
        payloadFile("reads", { absent_public_id: id("ctx-absent-msg"), pages: {} }),
      ]);
      const events = eventsOf(run.stdout);

      // §6: reads return null for an absent scoped identity — never not_found,
      // whose fixed message is node-specific.
      expect(eventFor(events, "read:absent-peer")).toBe("read:absent-peer null");
      expect(eventFor(events, "read:absent-message")).toBe("read:absent-message null");
      expect(eventFor(events, "read:absent-workspace")).toBe(
        `read:absent-workspace ${PUB_ERR} invalid_reference /workspace_name`,
      );
      expect(eventFor(events, "read:list-missing-session")).toBe(
        `read:list-missing-session ${PUB_ERR} invalid_reference /session_name`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// ── shared queue, both poison directions, one-shot close ─────────────────────

describe.skipIf(!READY)(`shared owner lifecycle [${PENDING}]`, () => {
  test(
    "a parked context write holds the queue while reads answer, and its failure stops every facade",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("queue-poison", {
        park_at: "before_write",
        // §7: the failure must come AFTER the row was attempted, which is what
        // poisons. A pre-write hook failure is a different rule, covered below.
        throw_at: "after_write",
        hold_ms: 20_000,
        vocabulary_request: {
          workspace_name: ALPHA,
          vocabulary_id: IDS.vocabulary,
          name: "ctx-probe",
          label: "Ctx probe",
          description: null,
          kind: "tags",
          term_policy: "open",
          cardinality: "many",
          required: false,
          hierarchy: "flat",
        },
      });
      const owner = spawnGatedChild(root, OWNERSHIP_CHILD, ["queue-poison", root, payload]);
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

      try {
        expect(await readUntil("context:parked")).toBe("context:parked");
        // Reads are off the write queue: this answers while the write is parked.
        expect((await readUntil("read:while-parked")).startsWith("read:while-parked ")).toBe(true);
        expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

        // The hook threw AFTER the row was attempted, so the owner is poisoned.
        expect(await readUntil("write:first")).toBe(`write:first ${PUB_ERR} recovery_required (root)`);
        expect(await readUntil("write:second")).toBe(`write:second ${PUB_ERR} recovery_required (root)`);
        // Poison blocks writes on every facade of the same owner, not just its own.
        expect(await readUntil("context:write-after")).toBe(
          `context:write-after ${PUB_ERR} recovery_required (root)`,
        );
        expect((await readUntil("taxonomy:write-after")).includes("recovery_required")).toBe(true);
        // …and leaves inspection reads usable.
        expect((await readUntil("read:after-release")).includes("recovery_required")).toBe(true);
        expect(await readUntil("owner:alive")).toBe("owner:alive");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a context bundle excludes every other opener of the dataset, and close is one-shot",
    async () => {
      const root = await freshDataset();
      const alias = join(scratch, "context-alias");
      symlinkSync(root, alias);
      const payload = payloadFile("cross-factory", { alias, hold_ms: 20_000 });
      const owner = spawnGatedChild(root, OWNERSHIP_CHILD, ["cross-factory", root, payload]);
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

      try {
        expect(await readUntil("owner:context")).toBe("owner:context ready");
        // One registry keyed on canonical identity: every other factory, and every
        // spelling, is refused while this owner holds the dataset.
        for (const label of [
          "second:context",
          "second:context-alias",
          "second:publication",
          "second:knowledge",
          "second:knowledge-alias",
        ]) {
          expect(await readUntil(label)).toBe(`${label} writer_unavailable`);
        }
        expect(await readUntil("close:same-promise")).toBe("close:same-promise true");
        expect(await readUntil("close:resolved")).toBe("close:resolved");
        // Close released the descriptor, so this process may not reopen…
        expect(await readUntil("reopen:after-close")).toBe("reopen:after-close writer_unavailable");
        expect(await readUntil("owner:alive")).toBe("owner:alive");

        // …while a separate process acquires the gate with the owner still alive.
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
        expect(eventsOf(contender.stdout)).toContain("gate:acquired");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a taxonomy failure after an attempted write stops later context writes on the same owner",
    async () => {
      const root = await freshDataset();
      const seedIds = {
        typeVocabulary: id("ctx-voc-type"),
        horizonVocabulary: id("ctx-voc-horizon"),
        note: id("ctx-t-note"),
        conclusion: id("ctx-t-concl"),
        learning: id("ctx-t-learn"),
        discussion: id("ctx-t-disc"),
        correction: id("ctx-t-corr"),
        short_term: id("ctx-t-short"),
        long_term: id("ctx-t-long"),
      };
      const payload = payloadFile("taxonomy-poison", {
        seed_request: {
          workspace_name: ALPHA,
          type: {
            vocabulary_id: seedIds.typeVocabulary,
            terms: {
              note: seedIds.note,
              conclusion: seedIds.conclusion,
              learning: seedIds.learning,
              discussion: seedIds.discussion,
              correction: seedIds.correction,
            },
          },
          memory_horizon: {
            vocabulary_id: seedIds.horizonVocabulary,
            terms: { short_term: seedIds.short_term, long_term: seedIds.long_term },
          },
        },
      });
      const run = await runGated(root, OWNERSHIP_CHILD, ["taxonomy-poison-first", root, payload]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "taxonomy:seed").includes("recovery_required")).toBe(true);
      // The mirror of the previous case: the other facade's write is stopped too.
      expect(eventFor(events, "context:write-after")).toBe(
        `context:write-after ${PUB_ERR} recovery_required (root)`,
      );
      expect(eventFor(events, "context:read-after").includes("recovery_required")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
