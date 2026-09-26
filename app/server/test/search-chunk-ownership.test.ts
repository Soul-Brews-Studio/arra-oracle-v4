// #30 search-chunk ownership evidence — four context-bearing facades, shared
// queue/poison in both directions, one-shot close, and cross-factory
// exclusion. Modelled on the accepted, hard-reviewed
// `read-cursor-ownership.test.ts` (§8 OWNERSHIP), generalised for the
// search-chunk kernel's write shape.
//
// Authority: `app/docs/contracts/search-chunk-v1.md` (§§1-10, base f600636,
// five kernels integrated, full suite 766/0). The frozen-384-dimension
// refusal, the never-network-call guard, deterministic-id/no-duplicate
// recovery and the bounded reconcile sweep belong to
// `search-chunk-recovery.test.ts`; method semantics and grammar to
// `search-chunk-service.test.ts`. None is duplicated here.
//
// Every expected value is authored HERE from the contract: facade key sets,
// the nine runtime exports, the deterministic chunk row and error envelopes.
// Requests are built in this file, so no builder can define its own
// expectations.
//
// Bounded claims: one cooperative local gate, disposable fixtures, pinned Bun
// and Python on Darwin. Boundary hooks prove commanded ordering, not real SDK
// failure (that is `search-chunk-recovery.test.ts`'s job).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PYTHON, createFixture, revisionEnvelope, runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";
import { CHUNKER_VERSION, deriveChunkId, deriveContentHash } from "../src/publication/search-chunk";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OWNERSHIP_CHILD = join(TEST_DIR, "fixtures", "search-chunk-v1", "ownership", "search-chunk-child.ts");
const TEST_TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const CLOCK_MS = 1_790_300_000_000;
const CLOCK_TEXT = new Date(CLOCK_MS).toISOString();
const PROFILE = { name: "test-profile", dims: 384 };

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_A = pad("ownNodeA");
const REV_A1 = pad("ownRevA1");

// ── independent oracles, authored from the contract ──────────────────────────

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
/** §1: derived from `service.ts`'s actual returned method sets across all
 *  five integrated kernels, independently confirmed by reading the source
 *  (grep for `indexRevisionChunks` / `listSearchChunks` / `reconcileSearchChunks`
 *  in `createContextWriterService`'s returned object), never handed a count. */
// Overnight R18: + closeSession (K9, D7) on every writer, + listSessionMembers (K10) on both.
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,appendMessages,closeSession,createSessionLink,createTrace,getContext," +
  "getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "indexRevisionChunks,joinSession,listConnections,listLifecycleHistory,listMcpCalls," +
  "listMessages,listPeers,listSearchChunks,listSessionLinks,listSessionMembers,listSessions,listTraceHits," +
  "reconcileSearchChunks,registerPeer,registerSession,retireNode,supersedeNode," +
  "writeChunkEmbedding";
const CONTEXT_READ_METHODS =
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "listConnections,listLifecycleHistory,listMcpCalls,listMessages,listPeers," +
  "listSearchChunks,listSessionLinks,listSessionMembers,listSessions,listTraceHits";
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
const peerRow = (peerId: string, peerName: string) => ({
  id: peerId,
  name: peerName,
  workspace_name: ALPHA,
  h_metadata: null,
  internal_metadata: null,
  configuration: null,
  created_at: CLOCK_TEXT,
});

const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);

const indexRequest = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  node_id: NODE_A,
  revision_id: REV_A1,
  chunker_version: CHUNKER_VERSION,
  embedding_profile: PROFILE,
  ...overrides,
});
const listRequest = () => ({
  workspace_name: ALPHA,
  revision_id: REV_A1,
  chunker_version: CHUNKER_VERSION,
  embedding_profile: PROFILE.name,
});

// ── scratch ──────────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-search-chunk-ownership-"));
const cleanups: { label: string; run: () => Promise<void> }[] = [];

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

async function runChildOk(root: string, args: string[], label: string) {
  const run = await runGated(root, OWNERSHIP_CHILD, args);
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
  const envelopeUntil = async (label: string): Promise<Envelope> =>
    JSON.parse((await readUntil(`json:${label}`)).slice(`json:${label} `.length)) as Envelope;
  const expectPoisoned = async (label: string) => {
    const envelope = await envelopeUntil(label);
    expect({ label, ok: envelope.ok }).toEqual({ label, ok: false });
    expect(envelope.error).toEqual(pubError("recovery_required", "", RECOVERY_REQUIRED));
  };
  const expectValue = async (label: string, value: unknown) => {
    const envelope = await envelopeUntil(label);
    expect({ label, ok: envelope.ok, error: envelope.error ?? null }).toEqual({ label, ok: true, error: null });
    expect({ label, value: envelope.value ?? null }).toEqual({ label, value: value ?? null });
  };
  return { readUntil, envelopeUntil, expectPoisoned, expectValue };
}

/** A real accepted revision published under NODE_A/REV_A1, so
 *  `indexRevisionChunks` has something genuine to point at. Returns the
 *  seeded workspace so the expected chunk row can be authored from its OWN
 *  term ids. */
async function seededDataset(label: string) {
  const fixture = await createFixture([ALPHA]);
  cleanups.push({ label, run: fixture.cleanup });
  const seeded = fixture.workspaces[ALPHA]!;
  const events = await runChildOk(
    fixture.datasetRoot,
    [
      "setup",
      fixture.datasetRoot,
      payloadFile(`${label}-setup`, {
        setup: {
          publish: {
            facade: "publication",
            method: "publishRevision",
            request: { operation_id: `${label}-op`, content: revisionEnvelope(ALPHA, seeded, NODE_A) },
          },
        },
        revision_ids: [REV_A1],
      }),
    ],
    `${label}-setup`,
  );
  const published = okValue(events, "setup:publish") as { outcome?: string };
  expect({ label, outcome: published.outcome }).toEqual({ label, outcome: "accepted" });
  return { datasetRoot: fixture.datasetRoot, seeded };
}

/** The exact wire row a fresh indexRevisionChunks over the seeded content
 *  produces, authored HERE from the contract and the seeded fixture's own
 *  term ids — never echoed back from the write under test. Body content
 *  ("a title\n\na body", from `revisionEnvelope`) is well under the 1000-char
 *  chunk size, so this is always exactly ONE chunk at index 0. */
function expectedChunkRow(seeded: { term_ids: { type: { note: { id: string } } }; session_name: string }) {
  const text = "a title\n\na body";
  return {
    id: deriveChunkId(REV_A1, CHUNKER_VERSION, PROFILE.name, 0n),
    workspace_name: ALPHA,
    node_id: NODE_A,
    revision_id: REV_A1,
    chunk_index: "0",
    text,
    content_hash: deriveContentHash(text),
    chunker_version: CHUNKER_VERSION,
    embedding_profile: PROFILE.name,
    type_term_id: seeded.term_ids.type.note.id,
    term_ids: [seeded.term_ids.type.note.id],
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: seeded.session_name,
    status: "pending",
    attempts: "0",
    last_attempt_at: null,
    embedded_at: null,
    error_code: null,
  };
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
    "each writer facade carries twenty-two methods and each reader facade eleven, with exports unchanged",
    async () => {
      const { datasetRoot: root } = await seededDataset("facades");
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

// ── shared owner: queue, poison in both directions, one-shot close ───────────

describe("shared owner: queue, poison in both directions, one-shot close", () => {
  const poisonedOwner = async (
    label: string,
    root: string,
    seeded: { term_ids: { type: { note: { id: string } } }; session_name: string },
    payload: Record<string, unknown>,
    expected: { parked: unknown; poisoned: unknown; peer?: Record<string, unknown> | null },
  ) => {
    const owner = spawnGatedChild(root, OWNERSHIP_CHILD, [
      "queue-poison",
      root,
      payloadFile(label, {
        park_at: "before_write",
        // §5: the failure must come AFTER the row was attempted.
        throw_at: "after_write",
        hold_ms: 20_000,
        revision_ids: [REV_A1],
        chunk_after_method: "indexRevisionChunks",
        chunk_after_request: indexRequest({ node_id: `${label}-node-after`.slice(0, 21) }),
        peer_request: { workspace_name: ALPHA, peer_id: id(`${label}-after`), name: `${label}-after` },
        read_method: "listSearchChunks",
        read_request: listRequest(),
        ...payload,
      }),
    ]);
    const { readUntil, expectPoisoned, expectValue } = ownerReader(owner);
    try {
      expect(await readUntil("chunk:parked")).toBe("chunk:parked");
      await expectValue("parked:read", expected.parked);
      expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

      await expectPoisoned("write:first");
      await expectPoisoned("write:second");
      // Both directions on one owner, unrelated to the node used above (a
      // node id that does not resolve would refuse for the WRONG reason).
      await expectPoisoned("chunk:write-after");
      await expectPoisoned("context:write-after");
      await expectValue("poisoned:read", expected.poisoned);
      if (expected.peer !== undefined) await expectValue("poisoned:peer-get", expected.peer);
      await expectPoisoned("released:read");
      expect(await readUntil("owner:alive")).toBe("owner:alive");
    } finally {
      owner.kill();
      await owner.wait().catch(() => undefined);
    }
    void seeded;
  };

  test(
    "a poisoned search-chunk write leaves the attempted row readable, and blocks a queued context write",
    async () => {
      const { datasetRoot: root, seeded } = await seededDataset("poison-chunk");
      await poisonedOwner(
        "poison-chunk",
        root,
        seeded,
        {
          first_method: "indexRevisionChunks",
          first_request: indexRequest(),
          second_method: "registerPeer",
          second_request: { workspace_name: ALPHA, peer_id: id("sc-peer-3"), name: "sc-third" },
        },
        {
          parked: [],
          // §5: the hook threw AFTER the append, so the row IS on disk.
          poisoned: [expectedChunkRow(seeded)],
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a poisoned CONTEXT write blocks a queued search-chunk write, and the chunk list stays empty",
    async () => {
      const { datasetRoot: root, seeded } = await seededDataset("poison-context");
      await poisonedOwner(
        "poison-context",
        root,
        seeded,
        {
          first_method: "registerPeer",
          first_request: { workspace_name: ALPHA, peer_id: id("sc-peer-5"), name: "sc-fifth" },
          second_method: "indexRevisionChunks",
          second_request: indexRequest(),
          peer_get_request: { workspace_name: ALPHA, peer_name: "sc-fifth" },
        },
        {
          parked: [],
          // The queued indexRevisionChunks call never ran.
          poisoned: [],
          peer: peerRow(id("sc-peer-5"), "sc-fifth"),
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a context writer excludes every other factory and spelling, and close is one-shot",
    async () => {
      const { datasetRoot: root } = await seededDataset("cross-factory");
      const alias = join(scratch, "chunk-alias");
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
