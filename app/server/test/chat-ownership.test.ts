// #32 chat ownership evidence — closed facade surfaces, runtime exports, the
// bundle-only one-shot close, writer-gate exclusion, and the shared owner's
// queue/poison behaviour AS IT ACTUALLY APPLIES to chat.
//
// Authority: `app/docs/contracts/context-ingestion-v1.md` §1/§8 and
// `src/publication/chat.ts` / `src/publication/service.ts` (`getContext`,
// `answerChat`) -- there is no separate `chat-v1.md` contract file yet, so the
// facade shapes and the queue behaviour below are read directly off
// `service.ts` and stated as the derivation this file is authored from, the
// same discipline `read-cursor-ownership.test.ts` applies to its own contract.
//
// AMENDED for #32 slice A (overnight ruling R9): `answerChat` is no longer a
// writer method at all. It persists nothing, so it moved to the reader-side
// chat facade (`service.createChatService.ts`); the writer's context facade
// keeps `getContext` (spread from `reads`) and loses `answerChat`. The chat
// cases below drive that facade over the SAME owner's context reads.
//
// DERIVATION (as originally authored), stated once and re-verified
// independently of the coordinator's count: `service.ts` defines `getContext`
// inside `createContextReadMethods` (the reader) and `answerChat` inside
// `createContextWriterService` only, spread into the writer bundle via
// `...reads` plus twelve writer-only methods. Grep evidence:
//   - `grep -c '^export '` on service.ts → 9 VALUE/TYPE exports of which
//     exactly 9 are runtime bindings (`PublicationError` + eight `open*`
//     functions) -- confirmed below by re-deriving the list in the child.
//   - `createContextWriterService`'s returned object has 24 keys (its own 12
//     plus the 12 spread from `reads`); `createContextReadMethods` has 12.
// This reproduces the coordinator's 24 writer / 12 reader / 9 runtime-export
// figures independently; this file does not take them on faith.
//
// DISAGREEMENT WITH THE BRIEF, stated loudly because the brief assumed it
// without reading `service.ts`: there is NO "chat write". `answerChat` is
// documented in `service.ts` (search "Never wrapped in `mutate()`/`core.serial`")
// as deliberately NEVER entering the owner's write queue, and `getContext` is a
// plain read method that never did either. Concretely: `core.serial()` is the
// ONLY place the `poisoned` flag (in `createOwnerCore`) is ever read, and
// neither `getContext` nor `answerChat` calls it anywhere in their bodies. So
// there is no "poison propagates both directions between a chat write and an
// ordinary context write" case to prove -- chat has no write to poison FROM,
// and it is never blocked or poisoned by one either. What IS true, and is what
// this file proves instead: chat is queue-transparent. It answers correctly
// EVEN WHILE the owner is poisoned by an ordinary write, at every point in
// time (not merely "after release", since chat never queues behind the
// poisoning write in the first place), and a commanded MODEL failure inside
// `answerChat` cannot poison the owner for a later ordinary write, because
// `answerChat` never sets the flag `core.serial` checks.
//
// Bounded claims: one cooperative local gate, disposable fixtures, pinned Bun
// and Python on Darwin. This file owns itself and
// `test/fixtures/chat-v1/ownership/**` only; it does not edit or duplicate
// `context-ownership.test.ts`'s registration/append/membership cases, which
// are untouched and still the authority for those primitives.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextFixture } from "./helpers/context-fixture";
import { runGated, spawnGatedChild } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const TEST_DIR = import.meta.dir;
const CHILD = join(TEST_DIR, "fixtures", "chat-v1", "ownership", "chat-child.ts");
const TEST_TIMEOUT_MS = testTimeout(180_000);
const ALPHA = "alpha-workspace";

/** §1, re-derived independently, not copied from the coordinator's message. */
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
// #30 overnight R7/R8: `getSearchFreshness` (read) and `embedPendingChunks`
// (write-only) join the context facade -- the list below grew accordingly.
// Overnight R18: + closeSession (K9, D7) on every writer, + listSessionMembers (K10) on both.
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,appendMessages,closeSession,createSessionLink,createTrace,embedPendingChunks," +
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSearchFreshness," +
  "getSession,getTrace," +
  "indexRevisionChunks,joinSession,listConnections,listLifecycleHistory,listMcpCalls," +
  "listMessages,listPeers,listSearchChunks,listSessionLinks,listSessionMembers,listSessions,listTraceHits," +
  "reconcileSearchChunks,registerPeer,registerSession,retireNode,supersedeNode," +
  "writeChunkEmbedding";
const CONTEXT_WRITER_KEYS = "close,context,publication,taxonomy";

const RECOVERY_REQUIRED = "recovery_required";

const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);
const IDS = {
  session: id("chat-sess-1"),
  peer: id("chat-peer-1"),
  spare_peer: id("chat-peer-2"),
  third_peer: id("chat-peer-3"),
  message: id("chat-msg-1"),
};
const NAMES = {
  session: "chat-session-a",
  peer: "chat-observer",
  other_peer: "chat-poisoner",
  third_peer: "chat-third",
};

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-chat-ownership-"));
const cleanups: { label: string; run: () => Promise<void> }[] = [];

async function freshDataset(label: string): Promise<string> {
  const fixture = await createContextFixture([ALPHA]);
  cleanups.push({ label, run: fixture.cleanup });
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

const eventFor = (events: string[], name: string): string =>
  events.find((event) => event === name || event.startsWith(`${name} `)) ??
  `MISSING ${name} (saw ${JSON.stringify(events)})`;

type Envelope = { ok: boolean; value?: unknown };
const envelopeFor = (events: string[], label: string): Envelope => {
  const line = events.find((event) => event.startsWith(`json:${label} `));
  if (line === undefined) throw new Error(`no result for ${label}; saw ${JSON.stringify(events)}`);
  return JSON.parse(line.slice(`json:${label} `.length)) as Envelope;
};
const okValue = (events: string[], label: string): unknown => {
  const envelope = envelopeFor(events, label);
  expect({ label, ok: envelope.ok }).toEqual({ label, ok: true });
  return envelope.value;
};
/** A poisoned refusal: the FULL error shape lives on the same physical line,
 *  after the JSON blob, printed by the child's `shape()` helper. */
const errorLineOf = (events: string[], label: string): string => {
  const line = events.find((event) => event.startsWith(`json:${label} `));
  if (line === undefined) throw new Error(`no result for ${label}; saw ${JSON.stringify(events)}`);
  return line;
};

async function runChildOk(root: string, args: string[], label: string) {
  const run = await runGated(root, CHILD, args);
  expect({ label, code: run.code, stderr: run.stderr.slice(-500) }).toEqual({ label, code: 0, stderr: "" });
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
  return { readUntil };
}

afterAll(async () => {
  const failures: string[] = [];
  for (const { label, run } of cleanups) {
    await run().catch((error: unknown) => failures.push(`${label}: ${String(error)}`));
  }
  rmSync(scratch, { recursive: true, force: true });
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

// ── facade shapes, exports, and the derivation itself ───────────────────────

describe("closed facade surfaces, re-derived from service.ts directly", () => {
  test(
    "the writer carries getContext but not answerChat (R9), and exports stay at 9",
    async () => {
      const root = await freshDataset("surfaces");
      const writerEvents = await runChildOk(root, ["writer-surface", root, payloadFile("writer-surface", {})], "writer-surface");
      expect(eventFor(writerEvents, "writer:keys")).toBe(`writer:keys ${CONTEXT_WRITER_KEYS}`);
      expect(eventFor(writerEvents, "writer:context")).toBe(`writer:context ${CONTEXT_WRITE_METHODS}`);
      expect(eventFor(writerEvents, "writer:valuetypes")).toBe("writer:valuetypes function");
      expect(eventFor(writerEvents, "writer:exports")).toBe(`writer:exports ${RUNTIME_EXPORTS}`);

      const readerEvents = await runChildOk(root, ["reader-surface", root, payloadFile("reader-surface", {})], "reader-surface");
      expect(eventFor(readerEvents, "reader:keys")).toBe(`reader:keys context,publication,taxonomy`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "BITE TEST: a writer surface still carrying answerChat would be caught -- proven by mutating the expectation, not the source",
    async () => {
      // §-anti-pattern guard: an assertion never observed failing is not
      // evidence. This does not edit service.ts (forbidden); it proves the
      // ABOVE assertion is sensitive by asserting the WRONG list here and
      // confirming Bun reports a real mismatch, then discarding that result.
      const root = await freshDataset("bite-surfaces");
      const writerEvents = await runChildOk(root, ["writer-surface", root, payloadFile("bite-writer-surface", {})], "bite-writer-surface");
      const wrongList = CONTEXT_WRITE_METHODS.replace("advanceReadCursor,", "advanceReadCursor,answerChat,");
      expect(wrongList).not.toBe(CONTEXT_WRITE_METHODS);
      let threw = false;
      try {
        expect(eventFor(writerEvents, "writer:context")).toBe(`writer:context ${wrongList}`);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── bundle-only, one-shot close; writer-gate exclusion ──────────────────────

describe("one owner: bundle-only close, one-shot, and writer-gate exclusion", () => {
  test(
    "a context writer excludes a second context/evidence open, and close is one-shot",
    async () => {
      const root = await freshDataset("cross-factory");
      const owner = spawnGatedChild(root, CHILD, ["cross-factory", root, payloadFile("cross-factory", { hold_ms: 20_000 })]);
      const { readUntil } = ownerReader(owner);
      try {
        expect(await readUntil("owner:context")).toBe("owner:context ready");
        for (const label of ["second:context", "second:evidence"]) {
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

// ── the real property: chat is queue-transparent ────────────────────────────

describe("chat is queue-transparent: neither blocked by poison, nor a source of it", () => {
  test(
    "getContext and answerChat both succeed on an owner poisoned by an ordinary write, and a LATER ordinary write is still refused",
    async () => {
      const root = await freshDataset("chat-bypasses-poison");
      const owner = spawnGatedChild(root, CHILD, [
        "chat-bypasses-poison",
        root,
        payloadFile("chat-bypasses-poison", {
          throw_at: "after_write",
          hold_ms: 20_000,
        }),
      ]);
      const { readUntil } = ownerReader(owner);
      try {
        for (const step of ["setup:session", "setup:peer", "setup:join", "setup:append"]) {
          expect(await readUntil(`json:${step}`)).toContain('"ok":true');
        }
        // The poisoning write itself failed with recovery_required (an
        // after_write boundary threw, so the append it guarded is durable and
        // the owner is poisoned from here on).
        const firstLine = await readUntil("json:write:first");
        expect(firstLine).toContain('"ok":false');
        expect(firstLine).toContain(RECOVERY_REQUIRED);

        // getContext succeeds DESPITE the poison -- it never checks the flag.
        const getContextLine = await readUntil("json:getContext:while-poisoned");
        expect(getContextLine).toContain('"ok":true');
        // answerChat succeeds too, and the model really ran once.
        const answerLine = await readUntil("json:answerChat:while-poisoned");
        expect(answerLine).toContain('"ok":true');
        expect(await readUntil("model:calls-after-poisoned-chat")).toBe("model:calls-after-poisoned-chat 1");

        // A genuine ORDINARY write on the SAME owner is still refused: the
        // poison is real and chat's success did not paper over it.
        const secondWriteLine = await readUntil("json:write:after-poison");
        expect(secondWriteLine).toContain('"ok":false');
        expect(secondWriteLine).toContain(RECOVERY_REQUIRED);

        expect(await readUntil("owner:alive")).toBe("owner:alive");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "BITE TEST: the poisoned-refusal assertion above is sensitive to an unpoisoned owner, proven by flipping the expectation once",
    async () => {
      // Confirms `RECOVERY_REQUIRED` actually discriminates poisoned from
      // fresh state, rather than matching anything. A fresh owner's OWN first
      // write must NOT contain that phrase.
      const root = await freshDataset("bite-poison");
      const events = await runChildOk(
        root,
        ["answerchat-never-poisons", root, payloadFile("bite-poison", {})],
        "bite-poison",
      );
      const setupPeer = events.find((e) => e.startsWith("json:setup:peer"));
      // Guard the guard itself: the setup write must be visible before the
      // negative assertion below can mean anything.
      expect(setupPeer).toBeDefined();
      expect(setupPeer).not.toContain(RECOVERY_REQUIRED);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a commanded MODEL failure inside answerChat cannot poison the owner: the next ordinary write still succeeds",
    async () => {
      const root = await freshDataset("answerchat-never-poisons");
      const events = await runChildOk(
        root,
        ["answerchat-never-poisons", root, payloadFile("answerchat-never-poisons", {})],
        "answerchat-never-poisons",
      );
      for (const step of ["setup:session", "setup:peer", "setup:join"]) {
        expect(okValue(events, step)).toBeTruthy();
      }
      const failedAnswer = errorLineOf(events, "answerChat:model-failed");
      expect(failedAnswer).toContain('"ok":false');
      // #32 / R9: a model failure is `model_unavailable`, never a writer code.
      expect(failedAnswer).toContain("model_unavailable");
      // The owner is NOT poisoned: a genuine write right after succeeds.
      const followUp = okValue(events, "write:after-model-failure") as { outcome?: string };
      expect(followUp.outcome).toBe("created");
    },
    TEST_TIMEOUT_MS,
  );
});
