/**
 * #30 R20 (docs/overnight/DECISIONS.md): the embedding model digest is part
 * of the profile identity, and it is never silently mixed or flipped.
 *
 * Failing-first evidence (against `dfe646d`, the refuted fix round): the
 * digest was probed and pinned at SERVER BOOT, and `profile_id` embedded
 * the digest. The independent verifier measured both failure modes R20
 * names -- a healthy Ollama serving a NEW digest under the same model name
 * after the first pin kept the OLD profile id and kept embedding (two
 * models' vectors mixed in one profile), and a boot that ran before Ollama
 * came up flipped the profile id on the next measured boot, orphaning every
 * row indexed in between. Every test below fails at that commit: no run
 * ever returns `blocked`, no run ever refuses `embedding_profile_mismatch`,
 * and no embed run ever writes the pin.
 *
 * Every "restart" here is a REAL one: each `drive()` is a separate gated
 * child process with its own module state, against the same `mkdtemp`
 * dataset. The model is a stub embedder and the digest probe is a stub
 * (`fixtures/search-chunk-v1/embed/gated-embed.ts`'s `payload.digests`);
 * nothing contacts Ollama.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type SeededWorkspace } from "./helpers/publication-fixture";
import { CHUNKER_VERSION, activeEmbeddingProfileId } from "../src/publication/search-chunk";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/search-chunk-v1/embed/gated-embed.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK = Date.parse("2026-09-26T00:00:00.000Z");
const TEST_TIMEOUT_MS = testTimeout(300_000);
const PROFILE_ID = activeEmbeddingProfileId();

/** Two distinct digests in the measured `/api/tags` shape (64 lowercase hex). */
const DIGEST_A = "aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111";
const DIGEST_B = "bbbbbbbbbbbb2222222222222222222222222222222222222222222222222222";

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const hx = (method: string) => ({ facade: "harness", method, request: {} });

const drive = async (root: string, ops: unknown[], extra: Record<string, unknown>): Promise<Record<string, any>> => {
  const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1500)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 1500)}`);
  return JSON.parse(line);
};

const publish = (seeded: SeededWorkspace, node: string, operation: string, body: string) =>
  pub("publishRevision", { operation_id: operation, content: revisionEnvelope(ALPHA, seeded, node, { body }) });
const indexChunks = (node: string, revision: string) =>
  ctx("indexRevisionChunks", {
    workspace_name: ALPHA,
    node_id: node,
    revision_id: revision,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: { name: PROFILE_ID, dims: 384 },
  });
const embed = () => ctx("embedPendingChunks", { workspace_name: ALPHA, limit: 10 });
const freshness = () => ctx("getSearchFreshness", { workspace_name: ALPHA });
const rawChunks = (revision: string) =>
  ({ facade: "harness", method: "readRawRows", request: { table: "search_chunks_v1", predicate: `revision_id = '${revision}'` } });

const ok = (op: any, label: string) => {
  expect(op?.ok, `${label}: ${JSON.stringify(op)}`).toBe(true);
  return op.value;
};
const pinOf = (pinFile: any) => pinFile?.pins?.[PROFILE_ID]?.digest ?? null;

describe("R20 (1): the digest is pinned by the first embed run that actually writes a vector", () => {
  test("first run pins the measured digest; freshness reports pinned and last measured", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const node = pad("dp-pin-node");
      const rev = pad("dp-pin-rev");
      const parsed = await drive(
        fixture.datasetRoot,
        [publish(seeded, node, "op-dp-pin", "pin body"), indexChunks(node, rev), freshness(), hx("readPinFile"), embed(), hx("readPinFile"), freshness()],
        { revisionIds: [rev], embedderMode: "fixed", digests: [DIGEST_A] },
      );
      ok(parsed.op1, "index");
      // Indexing alone never pins: no vector exists yet.
      expect(ok(parsed.op2, "freshness before").vectors.model_digest).toEqual({ pinned: null, last_measured: null });
      expect(ok(parsed.op3, "pin before")).toBeNull();

      expect(ok(parsed.op4, "embed")).toEqual({
        attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null,
      });
      expect(pinOf(ok(parsed.op5, "pin after"))).toBe(DIGEST_A);
      const after = ok(parsed.op6, "freshness after");
      expect(after.vectors.profile_id).toBe(PROFILE_ID);
      expect(after.vectors.model_digest).toEqual({ pinned: DIGEST_A, last_measured: DIGEST_A });
      expect(parsed.probeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a run whose every embedder call fails writes no vector, so it pins nothing", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const node = pad("dp-nopin-node");
      const rev = pad("dp-nopin-rev");
      const parsed = await drive(
        fixture.datasetRoot,
        [publish(seeded, node, "op-dp-nopin", "no pin body"), indexChunks(node, rev), embed(), hx("readPinFile")],
        { revisionIds: [rev], embedderMode: "always-fail", digests: [DIGEST_A] },
      );
      expect(ok(parsed.op2, "embed")).toMatchObject({ embedded: 0, failed: 1, blocked: null });
      expect(ok(parsed.op3, "pin")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("R20 (2): every embed run probes before embedding anything", () => {
  test("same digest after a restart proceeds, and the pin is unchanged", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const [nodeA, nodeB] = [pad("dp-same-a"), pad("dp-same-b")];
      const [revA, revB] = [pad("dp-same-ra"), pad("dp-same-rb")];
      const first = await drive(
        fixture.datasetRoot,
        [publish(seeded, nodeA, "op-dp-same-a", "same body one"), indexChunks(nodeA, revA), embed()],
        { revisionIds: [revA], embedderMode: "fixed", digests: [DIGEST_A] },
      );
      expect(ok(first.op2, "first embed")).toMatchObject({ embedded: 1, blocked: null });

      const second = await drive(
        fixture.datasetRoot,
        [publish(seeded, nodeB, "op-dp-same-b", "same body two, different text"), indexChunks(nodeB, revB), embed(), hx("readPinFile")],
        { revisionIds: [revB], embedderMode: "fixed", digests: [DIGEST_A] },
      );
      expect(ok(second.op2, "second embed")).toEqual({
        attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null,
      });
      expect(pinOf(ok(second.op3, "pin"))).toBe(DIGEST_A);
      expect(second.embedCalls).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a changed digest after a restart fails closed: embedding_profile_mismatch naming both, zero vectors", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const [nodeA, nodeB] = [pad("dp-diff-a"), pad("dp-diff-b")];
      const [revA, revB] = [pad("dp-diff-ra"), pad("dp-diff-rb")];
      const first = await drive(
        fixture.datasetRoot,
        [publish(seeded, nodeA, "op-dp-diff-a", "diff body one"), indexChunks(nodeA, revA), embed(), hx("profileId")],
        { revisionIds: [revA], embedderMode: "fixed", digests: [DIGEST_A] },
      );
      expect(ok(first.op2, "first embed")).toMatchObject({ embedded: 1, blocked: null });

      // The verifier's exact scenario: same model name, healthy Ollama, a
      // different build behind it.
      const second = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeB, "op-dp-diff-b", "diff body two, different text"),
          indexChunks(nodeB, revB),
          embed(),
          rawChunks(revB),
          rawChunks(revA),
          hx("readPinFile"),
          freshness(),
          hx("profileId"),
          ctx("reconcileSearchChunks", { workspace_name: ALPHA, limit: 1024 }),
        ],
        { revisionIds: [revB], embedderMode: "fixed", digests: [DIGEST_B] },
      );
      const refused = second.op2;
      expect(refused.ok, JSON.stringify(refused)).toBe(false);
      expect(refused.code).toBe("embedding_profile_mismatch");
      expect(refused.envelope).toEqual({
        version: "arra-publication-error/v1",
        code: "embedding_profile_mismatch",
        path: "",
        message: "embedding model digest differs from the dataset's pinned digest",
        pinned_digest: DIGEST_A,
        measured_digest: DIGEST_B,
      });
      // Zero vectors written, zero embedder calls, the row untouched.
      expect(second.embedCalls).toEqual([]);
      const rowB = ok(second.op3, "raw B")[0];
      expect(rowB).toMatchObject({ status: "pending", attempts: "0", embedding: null, error_code: null });
      // The already-embedded row keeps its profile id and its vector.
      const rowA = ok(second.op4, "raw A")[0];
      expect(rowA.embedding_profile).toBe(PROFILE_ID);
      expect(rowA.status).toBe("ready");
      // Neither the pin nor the profile id flipped.
      expect(pinOf(ok(second.op5, "pin"))).toBe(DIGEST_A);
      const fresh = ok(second.op6, "freshness");
      expect(fresh.vectors.model_digest).toEqual({ pinned: DIGEST_A, last_measured: DIGEST_B });
      expect(fresh.vectors).toMatchObject({ profile_id: PROFILE_ID, ready: 1, pending: 1 });
      expect(ok(second.op7, "profile id")).toBe(ok(first.op3, "first profile id"));
      expect(ok(second.op8, "reconcile")).toMatchObject({ ready: 1, pending: 1 });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("an unmeasurable digest blocks: digest_unmeasured, zero vectors, attempts untouched, nothing pinned", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const node = pad("dp-unm-node");
      const rev = pad("dp-unm-rev");
      const parsed = await drive(
        fixture.datasetRoot,
        [publish(seeded, node, "op-dp-unm", "unmeasured body"), indexChunks(node, rev), embed(), rawChunks(rev), hx("readPinFile"), freshness()],
        { revisionIds: [rev], embedderMode: "fixed", digests: [null] },
      );
      expect(ok(parsed.op2, "embed")).toEqual({
        attempted: 0, embedded: 0, reused: 0, failed: 0, remaining: 1, skipped: 0, blocked: "digest_unmeasured",
      });
      expect(parsed.embedCalls).toEqual([]);
      // Not marked failed either: an Ollama outage must never burn the
      // row's retry budget (the verifier's stranding finding).
      expect(ok(parsed.op3, "raw")[0]).toMatchObject({ status: "pending", attempts: "0", embedding: null, error_code: null });
      expect(ok(parsed.op4, "pin")).toBeNull();
      expect(ok(parsed.op5, "freshness").vectors.model_digest).toEqual({ pinned: null, last_measured: null });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a hung probe is bounded and blocks; no probe configured blocks too", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const node = pad("dp-hang-node");
      const rev = pad("dp-hang-rev");
      const hung = await drive(
        fixture.datasetRoot,
        [publish(seeded, node, "op-dp-hang", "hang body"), indexChunks(node, rev), embed()],
        { revisionIds: [rev], embedderMode: "fixed", digests: ["hang"], digestTimeoutMs: 150 },
      );
      expect(ok(hung.op2, "hung embed")).toMatchObject({ embedded: 0, blocked: "digest_unmeasured", remaining: 1 });
      expect(hung.embedCalls).toEqual([]);

      const unconfigured = await drive(fixture.datasetRoot, [embed(), hx("readPinFile")], {
        embedderMode: "fixed",
        digests: "none",
      });
      expect(ok(unconfigured.op0, "unconfigured embed")).toMatchObject({ embedded: 0, blocked: "digest_unmeasured" });
      expect(unconfigured.embedCalls).toEqual([]);
      expect(ok(unconfigured.op1, "pin")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a digest that changes while the embedder runs writes nothing", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const node = pad("dp-mid-node");
      const rev = pad("dp-mid-rev");
      // Probe 1 (before the embedder) measures A, probe 2 (after it, before
      // any write) measures B: no single digest covers these vectors.
      const parsed = await drive(
        fixture.datasetRoot,
        [publish(seeded, node, "op-dp-mid", "mid body"), indexChunks(node, rev), embed(), rawChunks(rev), hx("readPinFile")],
        { revisionIds: [rev], embedderMode: "fixed", digests: [DIGEST_A, DIGEST_B] },
      );
      expect(ok(parsed.op2, "embed")).toMatchObject({ embedded: 0, blocked: "digest_unmeasured", remaining: 1 });
      expect(parsed.embedCalls).toHaveLength(1);
      expect(ok(parsed.op3, "raw")[0]).toMatchObject({ status: "pending", attempts: "0", embedding: null });
      expect(ok(parsed.op4, "pin")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("R20: a damaged pin is never read as \"not pinned\"", () => {
  test("an unreadable pin file is integrity_failure for embed and freshness; nothing embedded, nothing re-pinned", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const node = pad("dp-bad-node");
      const rev = pad("dp-bad-rev");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, node, "op-dp-bad", "damaged pin body"),
          indexChunks(node, rev),
          { facade: "harness", method: "writePinFile", request: { text: "{not json" } },
          embed(),
          freshness(),
          rawChunks(rev),
        ],
        { revisionIds: [rev], embedderMode: "fixed", digests: [DIGEST_A] },
      );
      expect(parsed.op3).toMatchObject({ ok: false, code: "integrity_failure" });
      expect(parsed.op4).toMatchObject({ ok: false, code: "integrity_failure" });
      expect(parsed.embedCalls).toEqual([]);
      expect(ok(parsed.op5, "raw")[0]).toMatchObject({ status: "pending", attempts: "0", embedding: null });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("R20: a restart sequence unmeasured-then-measured never changes any row's profile id", () => {
  test("boot 1 cannot measure, boot 2 can: the rows indexed under boot 1 are the ones boot 2 embeds", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const node = pad("dp-seq-node");
      const rev = pad("dp-seq-rev");
      const boot1 = await drive(
        fixture.datasetRoot,
        [publish(seeded, node, "op-dp-seq", "sequence body"), indexChunks(node, rev), embed(), hx("profileId"), rawChunks(rev)],
        { revisionIds: [rev], embedderMode: "fixed", digests: [null] },
      );
      expect(ok(boot1.op2, "boot 1 embed")).toMatchObject({ blocked: "digest_unmeasured", remaining: 1 });
      const id1 = ok(boot1.op3, "boot 1 profile id");
      expect(ok(boot1.op4, "boot 1 raw")[0].embedding_profile).toBe(id1);

      const boot2 = await drive(
        fixture.datasetRoot,
        [
          embed(),
          hx("profileId"),
          rawChunks(rev),
          ctx("listSearchChunks", {
            workspace_name: ALPHA,
            revision_id: rev,
            chunker_version: CHUNKER_VERSION,
            embedding_profile: id1,
          }),
          ctx("reconcileSearchChunks", { workspace_name: ALPHA, limit: 1024 }),
        ],
        { embedderMode: "fixed", digests: [DIGEST_A] },
      );
      // The row boot 1 indexed is exactly the row boot 2 embeds.
      expect(ok(boot2.op0, "boot 2 embed")).toEqual({
        attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null,
      });
      expect(ok(boot2.op1, "boot 2 profile id")).toBe(id1);
      const row = ok(boot2.op2, "boot 2 raw")[0];
      expect(row.embedding_profile).toBe(id1);
      expect(row.status).toBe("ready");
      // Still addressable under boot 1's id, and nothing reads as missing.
      expect(ok(boot2.op3, "list")).toHaveLength(1);
      expect(ok(boot2.op4, "reconcile")).toMatchObject({ missing: 0, ready: 1 });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
