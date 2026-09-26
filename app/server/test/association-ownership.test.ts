// #66 association ownership evidence — runtime/bundle/method sets, shared owner
// lifecycle, unchanged legacy factories, and cursor scope binding. Refs #66, Parent #28.
//
// Authority is `app/docs/contracts/association-evidence-v1.md`
// (SHA256 b4a9660de8e1d669396769f12973284973661fced86214e5f7b447b785e83f1e), §8 OWNERSHIP.
// Reconciliation fault/crash evidence belongs to `association-recovery.test.ts`; multi-page
// scan budgets, ordering and projection-divergence answers to `association-query.test.ts`;
// method semantics and request grammar to `association-service.test.ts`. This file
// duplicates none of them.
//
// Every expected value — key sets, the nine sorted runtime exports, codes, paths, envelopes
// and closed result objects — is authored HERE from the contract. Helper commitments are
// consumed for encoding and fixture creation only; identities and expectations are this
// file's own.
//
// Errors assert the runtime name AND all four wire fields: version, code, path and message.
// Where a message is governed validator call-site text this lane does not own, the other
// three are exact and the message is only required to be present — inventing one is how a
// wrong string survived a previous slice.
//
// Every child's exit code is asserted: the shared helpers RETURN codes rather than throwing,
// so an unchecked child can fail silently and leave a test asserting on empty output.
//
// Dependency status, recorded once: `openEvidenceReader`/`openEvidenceWriter` and
// `helpers/association-fixture.ts` are ABSENT at authoring time; the core lane owns both.
// Suites needing them skip with the blocker named in the title, and no skip is evidence.
//
// Bounded claims: one cooperative local gate, disposable gated fixtures, pinned Bun and
// Python on Darwin. Boundary hooks prove commanded ordering, not real SDK failure. Nothing
// here speaks to Linux, NFS, R2, multiwriter CAS, power loss, or to permission enforcement,
// which remains #25/#31 integration.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { targetOp } from "../src/contracts/evidence-v1";
import { parseStrict } from "../src/contracts/jcs";
import { PYTHON, revisionEnvelope, runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OWNERSHIP_CHILD = join(TEST_DIR, "fixtures", "association-v1", "ownership", "evidence-child.ts");
const TEST_TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

// ── independent oracles, authored from the contract ──────────────────────────

/** §1: the exact runtime exports, sorted as written. */
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
const WRITER_KEYS = "close,context,evidence,publication,taxonomy";
const READER_KEYS = "context,evidence,publication,taxonomy";
const EVIDENCE_WRITE_METHODS = "getRevisionAssociations,reconcileRevisionAssociations,scanDependents";
const EVIDENCE_READ_METHODS = "getRevisionAssociations,scanDependents";
const PUBLICATION_WRITE_METHODS = "getAcceptedHead,listAcceptedHistory,listNodes,publishRevision";
const PUBLICATION_READ_METHODS = "getAcceptedHead,listAcceptedHistory,listNodes";
const TAXONOMY_WRITE_METHODS =
  // K6+K7 (R18 (K6+K7+V8)): term listing, term usage counts and workspace stats.
  "createTerm,createVocabulary,getTerm,getVocabulary,knowledgeStats,listTermUsage,listTerms," +
  "lookupTermByName,lookupVocabularyByName,renameTerm,reparentTerm,retireTerm,seedReservedVocabularies";
// K2 (R18): the two by-name reads are on every taxonomy reader and writer facade.
const TAXONOMY_READ_METHODS = "getTerm,getVocabulary,knowledgeStats,listTermUsage,listTerms,lookupTermByName,lookupVocabularyByName"; // K6/K7 (R18 (K6+K7+V8))
const CONTEXT_WRITE_METHODS =
  "advanceReadCursor,appendMessages,createSessionLink,createTrace,getContext," +
  "getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "indexRevisionChunks,joinSession,listConnections,listLifecycleHistory,listMcpCalls," +
  "listMessages,listPeers,listSearchChunks,listSessionLinks,listSessions,listTraceHits," +
  "reconcileSearchChunks,registerPeer,registerSession,retireNode,supersedeNode," +
  "writeChunkEmbedding";
const CONTEXT_READ_METHODS =
  "getContext,getMessage,getPeer,getReadCursor,getRecallEligibility,getSession,getTrace," +
  "listConnections,listLifecycleHistory,listMcpCalls,listMessages,listPeers," +
  "listSearchChunks,listSessionLinks,listSessions,listTraceHits";
const LEGACY = {
  publication: { keys: "close,getAcceptedHead,listAcceptedHistory,listNodes,publishRevision", nested: {} },
  knowledge: {
    keys: "close,publication,taxonomy",
    nested: { publication: PUBLICATION_WRITE_METHODS, taxonomy: TAXONOMY_WRITE_METHODS },
  },
  context: {
    keys: "close,context,publication,taxonomy",
    nested: {
      context: CONTEXT_WRITE_METHODS,
      publication: PUBLICATION_WRITE_METHODS,
      taxonomy: TAXONOMY_WRITE_METHODS,
    },
  },
} as const;

/** §6 envelopes: governed for input/codec, publication for service/owner state. */
/** Fixed literals: publication messages are contract constants, and the cursor
 *  mismatch literal is published by the core lane. */
const CURSOR_MISMATCH = "evidence cursor does not match request";

const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);
const IDS = {
  node: id("assoc-node-1"),
  revision: id("assoc-rev-1"),
  peer: id("assoc-peer-1"),
  absentNode: id("assoc-absent"),
  typeVocabulary: id("assoc-voc-type"),
  horizonVocabulary: id("assoc-voc-hori"),
  note: id("assoc-t-note"),
  conclusion: id("assoc-t-concl"),
  learning: id("assoc-t-learn"),
  discussion: id("assoc-t-disc"),
  correction: id("assoc-t-corr"),
  short_term: id("assoc-t-short"),
  long_term: id("assoc-t-long"),
};

/** A typed target this file owns; §2 forbids a raw caller-supplied target key. */
const TARGET_KIND = "url";
const TARGET = { url: "https://example.invalid/evidence" };
/** Derived through the accepted codec, so a cursor can be bound correctly and
 *  only the field under test disagrees. */
const DERIVED_TARGET_KEY = targetOp(ALPHA, TARGET_KIND, parseStrict(JSON.stringify(TARGET), []), []).target_key;

// ── dependency probes ────────────────────────────────────────────────────────

const service = (await import(join(SERVER_DIR, "src", "publication", "service.ts")).catch(() => ({}))) as Record<
  string,
  unknown
>;
const associationHelper = (await import(join(TEST_DIR, "helpers", "association-fixture.ts")).catch(() => null)) as {
  createAssociationFixture?: (workspaces?: string[]) => Promise<{
    datasetRoot: string;
    workspaces: Record<string, { workspace_id: string }>;
    cleanup: () => Promise<void>;
  }>;
} | null;

const ENTRY_READY =
  typeof service.openEvidenceWriter === "function" && typeof service.openEvidenceReader === "function";
const FIXTURE_READY = typeof associationHelper?.createAssociationFixture === "function";
const READY = ENTRY_READY && FIXTURE_READY;
const PENDING = [
  ENTRY_READY ? null : "openEvidenceWriter/openEvidenceReader (core)",
  FIXTURE_READY ? null : "helpers/association-fixture.ts (core)",
]
  .filter(Boolean)
  .join(" + ");

// ── scratch ──────────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-association-ownership-"));
const cleanups: { label: string; run: () => Promise<void> }[] = [];

async function freshDataset(label: string): Promise<string> {
  const fixture = await associationHelper!.createAssociationFixture!([ALPHA, BETA]);
  cleanups.push({ label, run: fixture.cleanup });
  return fixture.datasetRoot;
}

function payloadFile(name: string, value: Record<string, unknown>): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify({ workspace: ALPHA, ...value }), { mode: 0o600 });
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
  if (line === undefined) throw new Error(`no json result for ${label}; saw ${JSON.stringify(events)}`);
  return JSON.parse(line.slice(`json:${label} `.length)) as Envelope;
};
/** A resolved value; fails loudly if the child reported an error instead. */
const okValue = (events: string[], label: string): unknown => {
  const envelope = envelopeFor(events, label);
  expect({ label, ok: envelope.ok, error: envelope.error ?? null }).toEqual({ label, ok: true, error: null });
  return envelope.value;
};
/** A thrown error as a closed object: name plus the four wire fields. */
const errorOf = (events: string[], label: string): Record<string, unknown> => {
  const envelope = envelopeFor(events, label);
  expect({ label, ok: envelope.ok }).toEqual({ label, ok: false });
  return envelope.error!;
};
/** Governed grammar messages belong to the service lane: presence is enough. */
const expectGovernedGrammar = (
  actual: Record<string, unknown>,
  expected: { code?: string; path: string },
) => {
  const { message, code, ...rest } = actual;
  expect(rest).toEqual({ name: "ContractError", version: "arra-error/v1", path: expected.path });
  if (expected.code !== undefined) expect(code).toBe(expected.code);
  else expect(typeof code === "string" && (code as string).length > 0).toBe(true);
  expect(typeof message === "string" && (message as string).length > 0).toBe(true);
};

/**
 * Run a gated child and REQUIRE a clean exit. The helper returns the code rather
 * than throwing, so an unasserted child can die and leave a test reasoning about
 * an empty event list.
 */
async function runChildOk(root: string, args: string[], label: string) {
  const run = await runGated(root, OWNERSHIP_CHILD, args);
  expect({ label, code: run.code, stderr: run.stderr.slice(-300) }).toEqual({ label, code: 0, stderr: "" });
  return eventsOf(run.stdout);
}

/** Requests, in the contract's exact grammar; every value is this file's own. */
const scanRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspace_name: ALPHA,
  target_kind: TARGET_KIND,
  target: TARGET,
  revision_mode: "current",
  limit: 10,
  cursor: null,
  ...overrides,
});
/** A correctly BOUND cursor: only the field under test is allowed to disagree. */
const boundCursor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspace_name: ALPHA,
  target_kind: TARGET_KIND,
  target_key: DERIVED_TARGET_KEY,
  revision_mode: "current",
  nodes_version: "1",
  node_id: IDS.node,
  revision_no: null,
  position: null,
  ...overrides,
});
const seedRequest = {
  workspace_name: ALPHA,
  type: {
    vocabulary_id: IDS.typeVocabulary,
    terms: {
      note: IDS.note,
      conclusion: IDS.conclusion,
      learning: IDS.learning,
      discussion: IDS.discussion,
      correction: IDS.correction,
    },
  },
  memory_horizon: {
    vocabulary_id: IDS.horizonVocabulary,
    terms: { short_term: IDS.short_term, long_term: IDS.long_term },
  },
};
/** A publication request valid once the reserved type vocabulary is seeded. */
const publishRequest = {
  operation_id: "assoc-setup-1",
  content: revisionEnvelope(
    ALPHA,
    {
      workspace_id: "unused",
      peer_names: [] as string[],
      session_name: null,
      vocabulary_ids: { type: IDS.typeVocabulary },
      term_ids: {
        type: {
          note: {
            id: IDS.note,
            name: "note",
            vocabulary_id: IDS.typeVocabulary,
            vocabulary_name: "type",
            is_active: true,
          },
        },
      },
    } as never,
    IDS.node,
    { author_peer_name: null, session_name: null },
  ),
};

/** Seed a real accepted revision under its OWN gated owner, before any test use. */
async function seededDataset(label: string): Promise<string> {
  const root = await freshDataset(label);
  const events = await runChildOk(
    root,
    [
      "setup",
      root,
      payloadFile(`${label}-setup`, {
        revision_id: IDS.revision,
        seed_request: seedRequest,
        publish_request: publishRequest,
        head_request: { workspace_name: ALPHA, node_id: IDS.node },
      }),
    ],
    `${label}-setup`,
  );

  // The setup's identities are asserted, not assumed: a later reconcile that
  // targeted a node this file never created would refuse before any boundary.
  const seed = okValue(events, "setup:seed") as { outcome?: string };
  expect(seed.outcome).toBe("created");
  const published = okValue(events, "setup:publish") as { outcome?: string; node_id?: string; revision_id?: string };
  expect({ outcome: published.outcome, node_id: published.node_id, revision_id: published.revision_id }).toEqual({
    outcome: "accepted",
    node_id: IDS.node,
    revision_id: IDS.revision,
  });
  const head = okValue(events, "setup:head") as { revision?: { id?: string } } | null;
  expect(head?.revision?.id).toBe(IDS.revision);
  return root;
}

afterAll(async () => {
  // Cleanup failures are reported per path rather than swallowed: a fixture that
  // cannot be removed is a finding about this harness, not noise to hide.
  const failures: string[] = [];
  for (const { label, run } of cleanups) {
    await run().catch((error: unknown) => failures.push(`${label}: ${String(error)}`));
  }
  rmSync(scratch, { recursive: true, force: true });
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

// ── surfaces: runtime exports, bundles, method sets ──────────────────────────

describe.skipIf(!READY)(`evidence composition surfaces [${PENDING}]`, () => {
  test(
    "the service exports exactly nine runtime names and both bundles carry their contracted facades",
    async () => {
      const root = await freshDataset("surfaces");
      const events = await runChildOk(root, ["surfaces", root, payloadFile("surfaces", {})], "surfaces");

      // §1: equality, not a subset — a subset check would accept a capability
      // export added later.
      expect(eventFor(events, "service:exports")).toBe(`service:exports ${RUNTIME_EXPORTS}`);

      expect(eventFor(events, "writer:keys")).toBe(`writer:keys ${WRITER_KEYS}`);
      expect(eventFor(events, "writer:evidence")).toBe(`writer:evidence ${EVIDENCE_WRITE_METHODS}`);
      expect(eventFor(events, "writer:publication")).toBe(`writer:publication ${PUBLICATION_WRITE_METHODS}`);
      expect(eventFor(events, "writer:taxonomy")).toBe(`writer:taxonomy ${TAXONOMY_WRITE_METHODS}`);
      expect(eventFor(events, "writer:context")).toBe(`writer:context ${CONTEXT_WRITE_METHODS}`);
      expect(eventFor(events, "writer:evidence-valuetypes")).toBe("writer:evidence-valuetypes function");
      expect(eventFor(events, "writer:evidence-prototype")).toBe("writer:evidence-prototype true");

      expect(eventFor(events, "reader:keys")).toBe(`reader:keys ${READER_KEYS}`);
      expect(eventFor(events, "reader:evidence")).toBe(`reader:evidence ${EVIDENCE_READ_METHODS}`);
      expect(eventFor(events, "reader:publication")).toBe(`reader:publication ${PUBLICATION_READ_METHODS}`);
      expect(eventFor(events, "reader:taxonomy")).toBe(`reader:taxonomy ${TAXONOMY_READ_METHODS}`);
      expect(eventFor(events, "reader:context")).toBe(`reader:context ${CONTEXT_READ_METHODS}`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "each accepted factory keeps its exact shape, measured in its own gated process",
    async () => {
      const root = await freshDataset("legacy");
      // One factory per child: closing releases fd 42, so a second open in the
      // same process would be refused for gate reasons, not shape reasons.
      for (const factory of ["publication", "knowledge", "context"] as const) {
        const events = await runChildOk(
          root,
          ["legacy-one", root, payloadFile(`legacy-${factory}`, { factory })],
          `legacy-${factory}`,
        );
        expect(eventFor(events, `legacy:${factory}`)).toBe(`legacy:${factory} ${LEGACY[factory].keys}`);
        for (const [nested, expected] of Object.entries(LEGACY[factory].nested)) {
          expect(eventFor(events, `legacy:${factory}:${nested}`)).toBe(`legacy:${factory}:${nested} ${expected}`);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ── shared owner: exclusion, one-shot close ──────────────────────────────────

describe.skipIf(!READY)(`shared owner exclusion and close [${PENDING}]`, () => {
  test(
    "an evidence writer excludes every other factory and spelling, and close is one-shot",
    async () => {
      const root = await freshDataset("cross-factory");
      const alias = join(scratch, "evidence-alias");
      symlinkSync(root, alias);
      const owner = spawnGatedChild(root, OWNERSHIP_CHILD, [
        "cross-factory",
        root,
        payloadFile("cross-factory", { alias, hold_ms: 20_000 }),
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

      try {
        expect(await readUntil("owner:evidence")).toBe("owner:evidence ready");
        for (const label of [
          "second:evidence",
          "second:evidence-alias",
          "second:context",
          "second:knowledge",
          "second:publication",
        ]) {
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

// ── shared queue, unqueued reads, poison across facades ──────────────────────

describe.skipIf(!READY)(`shared queue and fail-stop [${PENDING}]`, () => {
  test(
    "both evidence reads answer while a reconcile is parked and while poisoned, and fail after release",
    async () => {
      const root = await seededDataset("queue-poison");
      const readRequest = { workspace_name: ALPHA, node_id: IDS.node, revision_id: null };
      const payload = payloadFile("queue-poison", {
        revision_id: IDS.revision,
        park_at: "before_write",
        // §5: a real post-append boundary. `after_write` is not one of the seven.
        throw_at: "after_term_write",
        hold_ms: 20_000,
        reconcile_request: { workspace_name: ALPHA, node_id: IDS.node, revision_id: IDS.revision },
        read_request: readRequest,
        scan_request: scanRequest(),
        peer_request: { workspace_name: ALPHA, peer_id: IDS.peer, name: "assoc-author" },
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
      const envelopeUntil = async (label: string): Promise<Envelope> => {
        const event = await readUntil(`json:${label}`);
        return JSON.parse(event.slice(`json:${label} `.length)) as Envelope;
      };
      const valueUntil = async (label: string): Promise<Record<string, unknown> | null> => {
        const envelope = await envelopeUntil(label);
        expect({ label, ok: envelope.ok, error: envelope.error ?? null }).toEqual({ label, ok: true, error: null });
        return envelope.value as Record<string, unknown> | null;
      };
      /** The publication envelope, compared whole: name plus four wire fields. */
      const expectPoisoned = async (label: string) => {
        const envelope = await envelopeUntil(label);
        expect({ label, ok: envelope.ok }).toEqual({ label, ok: false });
        expect(envelope.error).toEqual({
          name: "PublicationError",
          version: "arra-publication-error/v1",
          code: "recovery_required",
          path: "",
          message: "writer recovery required",
        });
      };
      /** The association read of the seeded revision, whatever the owner's state. */
      const expectSeededAssociations = (value: Record<string, unknown> | null) => {
        expect(Object.keys(value ?? {}).sort()).toEqual([
          "content_digest",
          "is_snapshot_head",
          "links",
          "node_id",
          "revision_id",
          "snapshot_head_revision_id",
          "terms",
          "workspace_name",
        ]);
        expect({
          node_id: value?.node_id,
          revision_id: value?.revision_id,
          is_snapshot_head: value?.is_snapshot_head,
          terms: (value?.terms as unknown[]).length,
          links: value?.links,
        }).toEqual({
          node_id: IDS.node,
          revision_id: IDS.revision,
          is_snapshot_head: true,
          // Exactly the one reserved type assignment this file published, and no
          // links at all, so a fabricated row would show up as a count change.
          terms: 1,
          links: [],
        });
      };
      const expectEmptyPage = (value: Record<string, unknown> | null) => {
        expect(Object.keys(value ?? {}).sort()).toEqual(["next_cursor", "nodes_version", "occurrences", "outcome"]);
        expect({ outcome: value?.outcome, occurrences: value?.occurrences, next_cursor: value?.next_cursor }).toEqual({
          outcome: "page",
          occurrences: [],
          next_cursor: null,
        });
      };

      try {
        expect(await readUntil("evidence:parked")).toBe("evidence:parked");
        // §1: evidence reads bypass the queue, so BOTH answer mid-reconcile with
        // their real results, not merely "not an error".
        expectSeededAssociations(await valueUntil("parked:get"));
        expectEmptyPage(await valueUntil("parked:scan"));
        expect(await readUntil("write:first-resuming")).toBe("write:first-resuming");

        await expectPoisoned("write:first");
        await expectPoisoned("write:second");
        await expectPoisoned("evidence:write-after");
        await expectPoisoned("context:write-after");
        // §1: reads survive poison, with the same answers…
        expectSeededAssociations(await valueUntil("poisoned:get"));
        expectEmptyPage(await valueUntil("poisoned:scan"));
        // …and fail only after release.
        await expectPoisoned("released:get");
        await expectPoisoned("released:scan");
        expect(await readUntil("owner:alive")).toBe("owner:alive");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ── cursor scope/target/mode binding and envelopes ───────────────────────────

describe.skipIf(!READY)(`cursor binding and envelopes [${PENDING}]`, () => {
  test(
    "a bound cursor disagreeing in exactly one scope field is governed scope_mismatch at that pointer",
    async () => {
      const root = await seededDataset("cursor-scope");
      const events = await runChildOk(
        root,
        [
          "cursor",
          root,
          payloadFile("cursor-scope", {
            revision_id: IDS.revision,
            requests: {
              // Every cursor below is correctly bound EXCEPT the field named, so
              // the prescribed key-before-mode precedence cannot mask the case.
              wrong_key: scanRequest({ cursor: boundCursor({ target_key: "0".repeat(64) }) }),
              wrong_workspace: scanRequest({ cursor: boundCursor({ workspace_name: BETA }) }),
              wrong_kind: scanRequest({ cursor: boundCursor({ target_kind: "trace" }) }),
              wrong_mode: scanRequest({ cursor: boundCursor({ revision_mode: "history" }) }),
              // §6 static shape: position cannot be nonnull when revision_no is
              // null. That is parser-level, before any version or semantic check.
              static_shape: scanRequest({ cursor: boundCursor({ revision_no: null, position: "0" }) }),
              // §2: no raw caller-supplied target key anywhere in the request.
              raw_key: scanRequest({ target_key: DERIVED_TARGET_KEY }),
            },
            absent_read: { workspace_name: ALPHA, node_id: IDS.absentNode, revision_id: null },
          }),
        ],
        "cursor-scope",
      );

      for (const [label, pointer] of [
        ["wrong_key", "/cursor/target_key"],
        ["wrong_workspace", "/cursor/workspace_name"],
        ["wrong_kind", "/cursor/target_kind"],
        ["wrong_mode", "/cursor/revision_mode"],
      ] as const) {
        // The contract pins this message, so the whole closed object is compared.
        expect(errorOf(events, label)).toEqual({
          name: "ContractError",
          version: "arra-error/v1",
          code: "scope_mismatch",
          path: pointer,
          message: CURSOR_MISMATCH,
        });
      }

      // Static cursor shape is governed grammar the service lane owns: name,
      // version and pointer are exact, and the message need only be present.
      expectGovernedGrammar(errorOf(events, "static_shape"), { path: "/cursor/position" });
      // §2: a raw target key is an unexpected field in the closed request.
      expectGovernedGrammar(errorOf(events, "raw_key"), { code: "unexpected_field", path: "/target_key" });

      // §2: an absent node reads as exactly null, never not_found.
      expect(okValue(events, "read:absent-node")).toBe(null);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a correctly bound cursor at the current version but naming no such node is publication invalid_request",
    async () => {
      const root = await seededDataset("cursor-semantic");
      const events = await runChildOk(
        root,
        [
          "cursor",
          root,
          payloadFile("cursor-semantic", {
            revision_id: IDS.revision,
            requests: {},
            // The child fills nodes_version from a real page: only the node
            // identity is wrong, so this is the §4 semantic case, not §6 shape.
            version_probe: scanRequest(),
            semantic_request: scanRequest(),
            semantic_cursor: { ...boundCursor({ node_id: IDS.absentNode }), nodes_version: "1" },
            absent_read: { workspace_name: ALPHA, node_id: IDS.absentNode, revision_id: null },
          }),
        ],
        "cursor-semantic",
      );

      const version = eventFor(events, "semantic:version");
      expect(version.startsWith('semantic:version "')).toBe(true);
      expect(errorOf(events, "semantic_boundary")).toEqual({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_request",
        path: "/cursor/node_id",
        message: "invalid publication request",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a scan of a workspace with no dependents is a closed page with a null cursor",
    async () => {
      const root = await seededDataset("cursor-empty");
      const events = await runChildOk(
        root,
        [
          "cursor",
          root,
          payloadFile("cursor-empty", {
            revision_id: IDS.revision,
            requests: { empty: scanRequest() },
            absent_read: { workspace_name: ALPHA, node_id: IDS.absentNode, revision_id: null },
          }),
        ],
        "cursor-empty",
      );
      const page = okValue(events, "empty") as Record<string, unknown>;

      // The seeded revision cites no external target, so the scan is exhausted
      // immediately and cannot claim continuation.
      expect(Object.keys(page).sort()).toEqual(["next_cursor", "nodes_version", "occurrences", "outcome"]);
      expect({ outcome: page.outcome, occurrences: page.occurrences, next_cursor: page.next_cursor }).toEqual({
        outcome: "page",
        occurrences: [],
        next_cursor: null,
      });
      // nodes_version is canonical positive Int64 decimal TEXT, never a number.
      expect(typeof page.nodes_version).toBe("string");
      expect(/^[1-9][0-9]*$/.test(page.nodes_version as string)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
