// #49 taxonomy ownership evidence — composition, exclusion, queue, poison, close
// and the scoped/structural rules this lane owns. Refs #49, Parent #27.
//
// Authority is `app/docs/contracts/taxonomy-write-v1.md`
// (SHA256 4c126a7e8238e858b137b54f7c505125db37526a71d0a04acf6663ff1237df8e), which
// explicitly extends revision-publication-v1.md §11 for these paths. Taxonomy request
// semantics beyond what is listed here belong to `taxonomy-service.test.ts`, and crash
// reconstruction to `taxonomy-recovery.test.ts`.
//
// Every expected value below — surfaces, codes, paths, the literal reserved rows and the
// boundary trace — is authored HERE from the contract, never read back from the code or
// the builders under test. The shared builders are used only to assemble requests, with
// this file supplying the identities, so a builder defect cannot quietly define its own
// expectations.
//
// Dependency status, stated rather than implied. At the time of writing,
// the kernel lane (#47) owns `openKnowledgeWriter`/`openKnowledgeReader`, `taxonomy.ts` and
// `helpers/taxonomy-fixture.ts`, and the recovery lane (#48) owns the Python bare-fixture
// exporter. Suites needing a dependency skip with it named in the title, so a missing module
// proves absence, never behaviour.
//
// Bounded claims: one cooperative local gate on a disposable Darwin dataset with the pinned
// Bun and Python. Nothing here speaks to Linux, NFS, R2, multiwriter CAS, power loss, or to
// same-UID code that declines to take the gate. Boundary hooks prove commanded ordering,
// not real SDK failure; a real persistence failure is a separate case in the recovery lane.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PYTHON, revisionEnvelope, runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";

const TEST_DIR = import.meta.dir;
const SERVER_DIR = resolve(TEST_DIR, "..");
const OWNERSHIP_DIR = join(TEST_DIR, "fixtures", "taxonomy-v1", "ownership");
const KNOWLEDGE_CHILD = join(OWNERSHIP_DIR, "knowledge-child.ts");
const STRUCTURE_CHILD = join(OWNERSHIP_DIR, "structure-child.ts");
const STAGE_CHAIN = join(OWNERSHIP_DIR, "stage-chain.py");

const TEST_TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

// ── independent oracles, authored from the contract ──────────────────────────

/** The exact runtime exports §11-extension allows from service.ts, and nothing else. */
const ALLOWED_SERVICE_EXPORTS = [
  "PublicationError",
  "openContextReader",
  "openContextWriter",
  "openEvidenceReader",
  "openEvidenceWriter",
  "openKnowledgeReader",
  "openKnowledgeWriter",
  "openPublicationReader",
  "openPublicationWriter",
];
const FORBIDDEN_SERVICE_EXPORTS = [
  "makeAdapter",
  "openDatasetOwner",
  "openPrivateConnection",
  "createTaxonomyService",
  "createPublicationWriterService",
  "adapter",
  "connection",
  "table",
];

const TAXONOMY_METHODS = [
  "createTerm",
  "createVocabulary",
  "getTerm",
  "getVocabulary",
  "renameTerm",
  "reparentTerm",
  "retireTerm",
  "seedReservedVocabularies",
].join(",");
const PUBLICATION_WRITE_METHODS = "getAcceptedHead,listAcceptedHistory,listNodes,publishRevision";
const PUBLICATION_READ_METHODS = "getAcceptedHead,listAcceptedHistory,listNodes";
const TAXONOMY_READ_METHODS = "getTerm,getVocabulary";

/** nanoid21 identities supplied by this file, so no builder invents them. */
const id = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);
const SEED_IDS = {
  typeVocabulary: id("own-voc-type"),
  horizonVocabulary: id("own-voc-horizon"),
  note: id("own-t-note"),
  conclusion: id("own-t-concl"),
  learning: id("own-t-learn"),
  discussion: id("own-t-disc"),
  correction: id("own-t-corr"),
  short_term: id("own-t-short"),
  long_term: id("own-t-long"),
};
const SPARE_TERM_IDS = [0, 1, 2, 3].map((n) => id(`own-spare-t${n}`));
const SPARE_VOCABULARY_IDS = [0, 1].map((n) => id(`own-spare-v${n}`));

/** Contract §"Bootstrap request and literal rows" — the reserved rows, in staging order. */
const EXPECTED_SEED_TERM_ORDER = ["note", "conclusion", "learning", "discussion", "correction", "short_term", "long_term"];
const EXPECTED_SEED_VOCABULARY_ORDER = ["type", "memory_horizon"];
/** A complete fresh seed emits 9 before_write, 7 after_term_write, 2 after_vocabulary_write, 9 after_readback. */
const EXPECTED_FRESH_TRACE = {
  before_write: 9,
  after_term_write: 7,
  after_vocabulary_write: 2,
  after_readback: 9,
};

// ── dependency probes ────────────────────────────────────────────────────────

const service = (await import(join(SERVER_DIR, "src", "publication", "service.ts")).catch(() => ({}))) as Record<
  string,
  unknown
>;
const taxonomyHelper = (await import(join(TEST_DIR, "helpers", "taxonomy-fixture.ts")).catch(() => null)) as {
  createTaxonomyFixture?: (workspaces: string[]) => Promise<{
    datasetRoot: string;
    workspaces: Record<string, { workspace_id: string }>;
    cleanup: () => Promise<void>;
  }>;
} | null;

const ENTRY_READY =
  typeof service.openKnowledgeWriter === "function" && typeof service.openKnowledgeReader === "function";
const FIXTURE_READY = typeof taxonomyHelper?.createTaxonomyFixture === "function";
const READY = ENTRY_READY && FIXTURE_READY;
const MISSING = [
  ENTRY_READY ? null : "openKnowledgeWriter/openKnowledgeReader (#47)",
  FIXTURE_READY ? null : "helpers/taxonomy-fixture.ts (#47)",
]
  .filter(Boolean)
  .join(" + ");
const PENDING = MISSING === "" ? "" : `pending ${MISSING}`;

// ── scratch and helpers ──────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-taxonomy-ownership-"));
const cleanups: (() => Promise<void>)[] = [];

async function freshDataset(): Promise<string> {
  const fixture = await taxonomyHelper!.createTaxonomyFixture!([ALPHA, BETA]);
  cleanups.push(fixture.cleanup);
  return fixture.datasetRoot;
}

function aliasOf(root: string, name: string): string {
  const link = join(scratch, name);
  symlinkSync(root, link);
  return link;
}

function payloadFile(name: string, value: unknown): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
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

/**
 * A publication request that is valid ONLY once the reserved type vocabulary is
 * seeded, which is what lets a publication write reach persistence in a dataset
 * this lane seeded through the taxonomy facade.
 */
function publishRequest(workspace: string, nodeId: string): Record<string, unknown> {
  const seededShape = {
    workspace_id: "unused",
    peer_names: [] as string[],
    session_name: null,
    vocabulary_ids: { type: SEED_IDS.typeVocabulary },
    term_ids: {
      type: {
        note: {
          id: SEED_IDS.note,
          name: "note",
          vocabulary_id: SEED_IDS.typeVocabulary,
          vocabulary_name: "type",
          is_active: true,
        },
      },
    },
  };
  return {
    operation_id: `ownership-${nodeId}`,
    content: revisionEnvelope(workspace, seededShape as never, nodeId, {
      author_peer_name: null,
      session_name: null,
    }),
  };
}

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
});

// ── always available: the runtime export surface ─────────────────────────────

describe("service runtime export surface", () => {
  test(
    "no adapter, owner, connection or facade constructor is exported, now or later",
    () => {
      // §11-extension: these nine RUNTIME exports and no others. Equality, not a
      // subset — a subset check would accept a capability export added later.
      expect(Object.keys(service).sort()).toEqual(ALLOWED_SERVICE_EXPORTS);
      expect(Object.keys(service).filter((name) => FORBIDDEN_SERVICE_EXPORTS.includes(name))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── composition surfaces ─────────────────────────────────────────────────────

describe.skipIf(!READY)(`knowledge composition surfaces [${PENDING}]`, () => {
  test(
    "the bundle exposes exactly publication, taxonomy and close, and only the taxonomy bundle may close",
    async () => {
      const root = await freshDataset();
      const run = await runGated(root, KNOWLEDGE_CHILD, ["surfaces", root, "", payloadFile("surfaces", { workspace: ALPHA, seed_ids: SEED_IDS })]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "bundle:keys")).toBe("bundle:keys close,publication,taxonomy");
      // Nested publication keeps its three data methods and NO close: the bundle
      // alone closes the owner.
      expect(eventFor(events, "bundle:publication")).toBe(`bundle:publication ${PUBLICATION_WRITE_METHODS}`);
      expect(eventFor(events, "bundle:taxonomy")).toBe(`bundle:taxonomy ${TAXONOMY_METHODS}`);
      expect(eventFor(events, "bundle:valuetypes")).toBe("bundle:valuetypes function");
      expect(eventFor(events, "bundle:prototype")).toBe("bundle:prototype true");

      expect(eventFor(events, "reader:keys")).toBe("reader:keys publication,taxonomy");
      expect(eventFor(events, "reader:publication")).toBe(`reader:publication ${PUBLICATION_READ_METHODS}`);
      expect(eventFor(events, "reader:taxonomy")).toBe(`reader:taxonomy ${TAXONOMY_READ_METHODS}`);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── cross-factory and alias exclusion ────────────────────────────────────────

describe.skipIf(!READY)(`cross-factory owner exclusion [${PENDING}]`, () => {
  test(
    "a knowledge bundle excludes every other opener of the same dataset, by any spelling",
    async () => {
      const root = await freshDataset();
      const alias = aliasOf(root, "bundle-alias");
      const payload = payloadFile("bundle-first", { workspace: ALPHA, seed_ids: SEED_IDS });
      const run = await runGated(root, KNOWLEDGE_CHILD, ["bundle-first", root, alias, payload]);
      const events = eventsOf(run.stdout);

      expect(events).toContain("owner:bundle ready");
      // One registry, one owner per canonical dataset: the publication factory and
      // a second bundle must both be refused, including through an alias path.
      expect(eventFor(events, "second:publication")).toBe("second:publication writer_unavailable");
      expect(eventFor(events, "second:bundle")).toBe("second:bundle writer_unavailable");
      expect(eventFor(events, "second:alias")).toBe("second:alias writer_unavailable");
      expect(eventFor(events, "second:alias-publication")).toBe("second:alias-publication writer_unavailable");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the exclusion holds in the other direction too",
    async () => {
      const root = await freshDataset();
      const alias = aliasOf(root, "publication-alias");
      const payload = payloadFile("publication-first", { workspace: ALPHA, seed_ids: SEED_IDS });
      const run = await runGated(root, KNOWLEDGE_CHILD, ["publication-first", root, alias, payload]);
      const events = eventsOf(run.stdout);

      expect(events).toContain("owner:publication ready");
      expect(eventFor(events, "second:bundle")).toBe("second:bundle writer_unavailable");
      expect(eventFor(events, "second:alias-bundle")).toBe("second:alias-bundle writer_unavailable");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── one queue, unqueued reads ────────────────────────────────────────────────

describe.skipIf(!READY)(`shared queue and unqueued reads [${PENDING}]`, () => {
  test(
    "a parked taxonomy write holds the queue while reads keep answering",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("queue", {
        workspace: ALPHA,
        seed_ids: SEED_IDS,
        second_vocabulary: { vocabulary_id: SPARE_VOCABULARY_IDS[0], name: "queue-probe" },
      });
      const run = await runGated(root, KNOWLEDGE_CHILD, ["queue-order", root, "", payload]);
      const events = eventsOf(run.stdout);

      // Reads answered while the write was parked mid-operation: they are off the
      // write queue, and a poisoned or busy writer does not blind an inspector.
      expect(events.indexOf("taxonomy:parked")).toBeLessThan(events.indexOf("read:taxonomy-while-parked null"));
      expect(eventFor(events, "read:taxonomy-while-parked")).toBe("read:taxonomy-while-parked null");
      expect(eventFor(events, "read:publication-while-parked")).toBe("read:publication-while-parked null");

      // The second write did not start, let alone finish, before the first was let go.
      expect(events.indexOf("write:second-finished")).toBeGreaterThan(events.indexOf("write:first-resuming"));
      expect(eventFor(events, "write:first")).toBe('write:first ok "created"');
      expect(eventFor(events, "write:second")).toBe('write:second ok "created"');
    },
    TEST_TIMEOUT_MS,
  );
});

// ── shared poison, both directions ───────────────────────────────────────────

describe.skipIf(!READY)(`shared fail-stop [${PENDING}]`, () => {
  test(
    "a taxonomy failure after an attempted write stops later publication writes",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("poison-taxonomy", {
        workspace: ALPHA,
        seed_ids: SEED_IDS,
        publish_request: publishRequest(ALPHA, id("own-node-a")),
      });
      const run = await runGated(root, KNOWLEDGE_CHILD, ["poison-taxonomy", root, "", payload]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "taxonomy:seed")).toBe("taxonomy:seed recovery_required");
      expect(eventFor(events, "taxonomy:after-poison")).toBe("taxonomy:after-poison recovery_required");
      expect(eventFor(events, "publication:after-poison")).toBe("publication:after-poison recovery_required");
      // Poison blocks writes, not inspection.
      expect(eventFor(events, "read:after-poison")).not.toBe("read:after-poison recovery_required");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a publication failure after an attempted write stops later taxonomy writes",
    async () => {
      const root = await freshDataset();
      // Seed through the taxonomy facade first, so the publication request below is
      // reference-valid and actually reaches persistence.
      const seedRun = await runGated(root, STRUCTURE_CHILD, [
        "references",
        root,
        payloadFile("seed-for-publication-poison", {
          workspace: ALPHA,
          other_workspace: BETA,
          seed_ids: SEED_IDS,
          spare_term_ids: SPARE_TERM_IDS,
          spare_vocabulary_ids: SPARE_VOCABULARY_IDS,
          other_type_vocabulary: id("own-voc-other"),
        }),
      ]);
      expect(eventsOf(seedRun.stdout)).toContain("seed created");

      const payload = payloadFile("poison-publication", {
        workspace: ALPHA,
        seed_ids: SEED_IDS,
        publish_request: publishRequest(ALPHA, id("own-node-b")),
      });
      const run = await runGated(root, KNOWLEDGE_CHILD, ["poison-publication", root, "", payload]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "publication:publish")).toBe("publication:publish recovery_required");
      expect(eventFor(events, "taxonomy:after-poison")).toBe("taxonomy:after-poison recovery_required");
      expect(eventFor(events, "read:after-poison")).not.toBe("read:after-poison recovery_required");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── one-shot close ───────────────────────────────────────────────────────────

describe.skipIf(!READY)(`one-shot close lifetime [${PENDING}]`, () => {
  test(
    "close waits for in-flight work, rejects queued work, is one-shot, and frees the gate while the process lives",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("close", { workspace: ALPHA, seed_ids: SEED_IDS, hold_ms: 20_000 });
      const owner = spawnGatedChild(root, KNOWLEDGE_CHILD, ["close", root, "", payload]);
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
        expect(await readUntil("taxonomy:parked")).toBe("taxonomy:parked");
        expect(await readUntil("close:called")).toBe("close:called");
        // One-shot: the second call returns the SAME promise rather than closing a
        // descriptor number that may since have been reused.
        expect(await readUntil("close:same-promise")).toBe("close:same-promise true");
        expect(await readUntil("close:in-flight")).toBe('close:in-flight ok "created"');
        // Read once: this stream is single-pass, so a second wait for the same
        // event would block until the child exited.
        const queued = await readUntil("close:queued");
        expect(queued.startsWith("close:queued ")).toBe(true);
        expect(queued).not.toBe('close:queued ok "created"');
        expect(await readUntil("close:resolved")).toBe("close:resolved");
        expect(await readUntil("close:second-resolved")).toBe("close:second-resolved");
        expect(await readUntil("close:read-after-release")).toBe("close:read-after-release recovery_required");

        // The owner process is deliberately still alive, so a contender acquiring
        // proves the descriptor was released by close rather than by death.
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
        expect(eventsOf(contender.stdout)).toContain("gate:acquired");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ── scoped references, tree bounds, retirement, documented ABA ───────────────

describe.skipIf(!READY)(`scoped references and policy refusals [${PENDING}]`, () => {
  test(
    "every unresolvable or policy-refused request is rejected with the contract's exact code and path",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("references", {
        workspace: ALPHA,
        other_workspace: BETA,
        seed_ids: SEED_IDS,
        spare_term_ids: SPARE_TERM_IDS,
        spare_vocabulary_ids: SPARE_VOCABULARY_IDS,
        other_type_vocabulary: id("own-voc-other"),
      });
      const run = await runGated(root, STRUCTURE_CHILD, ["references", root, payload]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "seed")).toBe("seed created");
      expect(eventFor(events, "cross-workspace-vocabulary")).toBe(
        "cross-workspace-vocabulary invalid_reference /vocabulary_id",
      );
      expect(eventFor(events, "absent-workspace")).toBe("absent-workspace invalid_reference /workspace_name");
      expect(eventFor(events, "reserved-name-create")).toBe("reserved-name-create invalid_request /name");
      expect(eventFor(events, "flat-parent")).toBe("flat-parent invalid_request /parent_id");
      expect(eventFor(events, "absent-rename-target")).toBe("absent-rename-target not_found /term_id");
      expect(eventFor(events, "cross-workspace-rename-target")).toBe(
        "cross-workspace-rename-target not_found /term_id",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ancestry of exactly 1024 rows is accepted and 1025 fails limit_exceeded",
    async () => {
      for (const [depth, expected] of [
        [1024, "reparent-at-limit updated"],
        // A root-path error prints an empty path, which event parsing trims away.
        [1025, "reparent-at-limit limit_exceeded"],
      ] as const) {
        const root = await freshDataset();
        const vocabularyId = id(`own-tree-${depth}`);
        const moverId = id(`own-mover-${depth}`);
        // Setup only: the chain is staged directly because reaching 1024 through
        // the kernel would be 1024 writes. The kernel decides only the boundary.
        const staged = await runOwnedChild(PYTHON, [STAGE_CHAIN, root, ALPHA, vocabularyId, String(depth), moverId], {
          deadlineMs: 120_000,
        });
        expect({ depth, code: staged.code, stderr: staged.stderr.slice(-200) }).toEqual({
          depth,
          code: 0,
          stderr: "",
        });
        const tip = JSON.parse(staged.stdout.trim()).tip_id as string;

        const payload = payloadFile(`tree-${depth}`, {
          workspace: ALPHA,
          other_workspace: BETA,
          seed_ids: SEED_IDS,
          mover_id: moverId,
          tip_id: tip,
        });
        const run = await runGated(root, STRUCTURE_CHILD, ["tree-boundary", root, payload]);
        const event = eventFor(eventsOf(run.stdout), "reparent-at-limit");
        // Equality is accepted; the 1025th visited row is the failure.
        expect({ depth, event: event.startsWith(expected) }).toEqual({ depth, event: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "retirement is monotonic, protects the last required term, and keeps the name occupied",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("retirement", {
        workspace: ALPHA,
        other_workspace: BETA,
        seed_ids: SEED_IDS,
        spare_term_ids: SPARE_TERM_IDS,
        spare_vocabulary_ids: SPARE_VOCABULARY_IDS,
      });
      const run = await runGated(root, STRUCTURE_CHILD, ["retirement", root, payload]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "seed")).toBe("seed created");
      for (const index of [0, 1, 2, 3]) {
        expect(eventFor(events, `retire-${index}`)).toBe(`retire-${index} updated`);
      }
      // `type` is the required reserved vocabulary, so the fifth retirement is refused.
      expect(eventFor(events, "retire-last-required")).toBe("retire-last-required invalid_request /term_id");
      expect(eventFor(events, "rename-retired")).toBe("rename-retired invalid_request /term_id");
      // A retired name is still occupied; identities are never recycled.
      expect(eventFor(events, "reuse-retired-name")).toBe("reuse-retired-name conflict /name");
      expect(eventFor(events, "retire-again")).toBe("retire-again already_satisfied");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a stale expected-value rename reapplies after a revert, which is the documented hazard",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("aba", {
        workspace: ALPHA,
        other_workspace: BETA,
        seed_ids: SEED_IDS,
        spare_term_ids: SPARE_TERM_IDS,
        spare_vocabulary_ids: SPARE_VOCABULARY_IDS,
      });
      const run = await runGated(root, STRUCTURE_CHILD, ["aba", root, payload]);
      const events = eventsOf(run.stdout);

      expect(eventFor(events, "aba-forward")).toBe("aba-forward updated");
      expect(eventFor(events, "aba-backward")).toBe("aba-backward updated");
      // NOT a defect: expected-value guards carry no version, so replaying the
      // stale first request after the revert applies it a second time. The
      // contract requires this to be demonstrated rather than merely disclaimed.
      expect(eventFor(events, "aba-stale-replay")).toBe("aba-stale-replay updated");
      // A guard that does not match the current value still conflicts, which is
      // what keeps the hazard above bounded rather than general.
      expect(eventFor(events, "expected-mismatch")).toBe("expected-mismatch conflict /expected_name");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── seed trace, owned here only as the ordering oracle other lanes reuse ─────

describe.skipIf(!READY)(`fresh seed boundary trace [${PENDING}]`, () => {
  test(
    "a complete fresh seed emits 9/7/2/9 boundaries in literal staging order",
    async () => {
      const root = await freshDataset();
      const payload = payloadFile("trace", { workspace: ALPHA, seed_ids: SEED_IDS });
      const run = await runGated(root, KNOWLEDGE_CHILD, ["trace", root, "", payload]);
      const events = eventsOf(run.stdout);
      expect(eventFor(events, "trace:seed")).toBe('trace:seed ok "created"');
      const counts = {
        before_write: events.filter((e) => e === "boundary before_write").length,
        after_term_write: events.filter((e) => e === "boundary after_term_write").length,
        after_vocabulary_write: events.filter((e) => e === "boundary after_vocabulary_write").length,
        after_readback: events.filter((e) => e === "boundary after_readback").length,
      };
      // Counts alone cannot prove WHICH row was written; the recovery lane owns the
      // per-prefix identity assertions. This case owns only the trace shape.
      expect(counts).toEqual(EXPECTED_FRESH_TRACE);
      expect(EXPECTED_SEED_TERM_ORDER.length + EXPECTED_SEED_VOCABULARY_ORDER.length).toBe(9);

      // Every term boundary precedes every vocabulary boundary: terms are staged
      // first so a required vocabulary is never visible without its terms.
      const lastTerm = events.lastIndexOf("boundary after_term_write");
      const firstVocabulary = events.indexOf("boundary after_vocabulary_write");
      expect(lastTerm).toBeLessThan(firstVocabulary);

      // A replay of the same manifest rewrites nothing, so it emits no mutation
      // boundary at all — skipped rows are skipped, not re-appended.
      const replayIndex = events.indexOf("trace:replay-start");
      expect(events.slice(replayIndex).filter((e) => e.startsWith("boundary "))).toEqual([]);
      expect(eventFor(events, "trace:replay")).toBe('trace:replay ok "already_satisfied"');
    },
    TEST_TIMEOUT_MS,
  );
});
