/**
 * #30 overnight R8: `embedPendingChunks`, the external/backfill embed worker
 * ("index first, embed later, like backfill" -- Nat).
 *
 * Failing-first evidence: before this slice, `embedPendingChunks` did not
 * exist at all -- `writeChunkEmbedding.ts`'s own header says computing a
 * vector "is somebody else's job", and analysis-30 measured that nothing
 * wired an embedder to that job. Every test below fails with `no_such_method`
 * against the pre-fix `context` facade.
 *
 * Uses a stub embedder injected through `openContextWriter`'s new
 * `documentEmbedder` option (a WRITER option, named apart from the
 * reader-only query embedder; `fixtures/search-chunk-v1/embed/gated-embed.ts`) --
 * never a real Ollama call. `ARRA_EMBED_TIMEOUT_MS` is set inside that child
 * BEFORE `service.ts` is imported, so the hang test times out in
 * milliseconds instead of the real 30s default.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type SeededWorkspace } from "./helpers/publication-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import {
  CHUNKER_VERSION,
  MAX_EMBED_ATTEMPTS,
  activeEmbeddingProfileId,
  deriveChunkId,
} from "../src/publication/search-chunk";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/search-chunk-v1/embed/gated-embed.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = testTimeout(300_000);
const PROFILE_ID = activeEmbeddingProfileId();

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });

const drive = async (
  root: string,
  ops: unknown[],
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> => {
  const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1500)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 1500)}`);
  return JSON.parse(line);
};

const publish = (seeded: SeededWorkspace, node: string, operation: string, overrides: Record<string, unknown> = {}) =>
  pub("publishRevision", { operation_id: operation, content: revisionEnvelope(ALPHA, seeded, node, overrides) });

const indexRequest = (node: string, revision: string) => ({
  workspace_name: ALPHA,
  node_id: node,
  revision_id: revision,
  chunker_version: CHUNKER_VERSION,
  embedding_profile: { name: PROFILE_ID, dims: 384 },
});

const embed = (limit = 10) => ctx("embedPendingChunks", { workspace_name: ALPHA, limit });
const listChunks = (revision: string) =>
  ctx("listSearchChunks", {
    workspace_name: ALPHA,
    revision_id: revision,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: PROFILE_ID,
  });
const freshness = () => ctx("getSearchFreshness", { workspace_name: ALPHA });

describe("embedPendingChunks: criterion 1, a hung embedder never blocks a concurrent write", () => {
  test("the embed call times out and fails closed while publishRevision proceeds normally", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-nodeA");
      const nodeB = pad("ew-nodeB");
      const revA = pad("ew-revA");
      const revB = pad("ew-revB");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-ew-a1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          {
            concurrent: [
              embed(),
              publish(seeded, nodeB, "op-ew-b1"),
            ],
          },
          listChunks(revA),
        ],
        { revisionIds: [revA, revB], embedderMode: "hang", embedTimeoutMs: 300 },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(1);

      const [embedResult, publishResult] = parsed.op2.concurrent;
      // The load-bearing property: publishRevision is NOT queued behind the
      // hung embedder call (which never resolves on its own). It SETTLES
      // FIRST; the embed call, which can only end by timing out, after it.
      // R13: observed order (`settledSeq`), no longer `elapsedMs < 250`,
      // which a slow runner broke with the order intact (search-chunk-v1 §19).
      expect(publishResult.ok, JSON.stringify(publishResult)).toBe(true);
      expect(publishResult.value.outcome).toBe("accepted");
      expect(publishResult.settledSeq).toBeLessThan(embedResult.settledSeq);

      // The embed call itself resolves once ITS OWN timeout fires, not
      // instantly and not forever.
      expect(embedResult.ok, JSON.stringify(embedResult)).toBe(true);
      expect(embedResult.value.attempted).toBe(1);
      expect(embedResult.value.failed).toBe(1);
      expect(embedResult.elapsedMs).toBeGreaterThanOrEqual(280);
      expect(embedResult.elapsedMs).toBeLessThan(scaledMs(5000));

      const listed = parsed.op3;
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0].status).toBe("failed");
      expect(listed.value[0].attempts).toBe("1");
      expect(listed.value[0].error_code).toBe("embedder_timeout");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  /**
   * Fix round finding 6a (test-quality): the test above uses `concurrent`
   * (`Promise.all`), which the independent verifier showed is decided by
   * SCHEDULING, not by the property under test -- mutation M4 (moving the
   * embedder call inside `core.serial`) still passed it 6/0, because
   * `publishRevision` happens to win the queue before the worker's own read
   * step finishes, regardless of where the embedder call sits. This version
   * uses `{handshake: {first, second}}` (`gated-embed.ts`): `second` (the
   * concurrent publish) starts ONLY once the stub embedder has genuinely
   * been invoked for `first` -- proof the embedder call is really in
   * flight, not a hope about ordering. A handshake-ordered version of this
   * exact test passes at HEAD (publish ~ms) and fails under M4 (publish
   * >1s, over the embed timeout) -- see the fix-round PR description.
   * R13 (search-chunk-v1 §19): that clock (`elapsedMs < 250`) broke on a slow
   * runner, and settle order alone lets M4 pass (2/0), so the embedder is HELD
   * until the publish settles; under M4 the publish runs only after the
   * timeout abandons the held call (`abortedWhileHeld`). Timeout path: above.
   */
  test("(deterministic handshake) publishRevision proceeds while the embedder is CONFIRMED in flight", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-hsA1");
      const nodeB = pad("ew-hsB1");
      const revA = pad("ew-hsrevA1");
      const revB = pad("ew-hsrevB1");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-ew-hs-a1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          { handshake: { first: embed(), second: publish(seeded, nodeB, "op-ew-hs-b1") } },
          listChunks(revA),
        ],
        // The timeout matters only under M4: it is what finally lets the publish run.
        { revisionIds: [revA, revB], embedderMode: "hold", embedTimeoutMs: scaledMs(10_000) },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(1);

      const { first: embedResult, second: publishResult, abortedWhileHeld } = parsed.op2;
      // CONFIRMED in flight before this write started (the handshake), and
      // still held, unanswered and not abandoned, when the write settled.
      expect(publishResult.ok, JSON.stringify(publishResult)).toBe(true);
      expect(publishResult.value.outcome).toBe("accepted");
      expect(abortedWhileHeld).toBe(false);
      expect(publishResult.settledSeq).toBeLessThan(embedResult.settledSeq);

      // Released only then, the held call completes normally.
      expect(embedResult.ok, JSON.stringify(embedResult)).toBe(true);
      expect(embedResult.value).toMatchObject({ attempted: 1, embedded: 1, failed: 0, skipped: 0 });

      const listed = parsed.op3.value;
      expect(listed[0].status).toBe("ready");
      expect(listed[0].error_code).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("embedPendingChunks: a concurrent writeChunkEmbedding is never clobbered by a stale batch plan (fix round finding 3)", () => {
  /**
   * `plan.row` (this batch's candidate snapshot) is read BEFORE the
   * embedder call, entirely outside `core.serial`. If a DIFFERENT writer
   * (`writeChunkEmbedding`) completes its own turn on the SAME row while
   * this batch's embedder call is still in flight, the worker must never
   * overwrite that newer state with its own stale plan when its turn
   * finally comes. Proven with a genuine handshake: `writeChunkEmbedding`
   * (`second`) starts only once the worker's `hang`-mode embedder call is
   * CONFIRMED in flight for `first`, so this is a real race, not a hope.
   */
  test("writeChunkEmbedding's write survives; the worker reports it as skipped, not failed", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-raceA1");
      const revA = pad("ew-racerevA1");
      const chunkId = deriveChunkId(revA, CHUNKER_VERSION, PROFILE_ID, 0n);
      const manualVector = Array.from({ length: 384 }, (_, i) => i / 384);
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-ew-race-1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          {
            handshake: {
              first: embed(),
              second: ctx("writeChunkEmbedding", { workspace_name: ALPHA, id: chunkId, embedding: manualVector }),
            },
          },
          listChunks(revA),
        ],
        { revisionIds: [revA], embedderMode: "hang", embedTimeoutMs: 300 },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(1);

      const { first: embedResult, second: writeResult } = parsed.op2;
      expect(writeResult.ok, JSON.stringify(writeResult)).toBe(true);
      expect(writeResult.value.outcome).toBe("embedded");
      expect(writeResult.value.row.status).toBe("ready");
      expect(writeResult.value.row.attempts).toBe("1");

      // The worker's own batch loses the race, and reports the loss
      // honestly instead of silently dropping the row or overwriting it.
      expect(embedResult.ok, JSON.stringify(embedResult)).toBe(true);
      expect(embedResult.value).toEqual({
        attempted: 1,
        embedded: 0,
        reused: 0,
        failed: 0,
        remaining: 0,
        skipped: 1,
        blocked: null,
      });

      // The row is left EXACTLY as `writeChunkEmbedding` left it -- never
      // reverted to failed/embedder_timeout by the worker's stale plan.
      const listed = parsed.op3.value;
      expect(listed).toHaveLength(1);
      expect(listed[0].status).toBe("ready");
      expect(listed[0].attempts).toBe("1");
      expect(listed[0].error_code).toBeNull();
      expect(listed[0].embedded_at).not.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("embedPendingChunks: an out-of-contract embedder response never reaches the writer (fix round finding 2)", () => {
  /**
   * `embed.ts`'s own dims check runs against the CONFIGURABLE
   * `EMBEDDING_DIMENSIONS` env var, not this registry's frozen 384 --
   * measured, a short batch or a non-finite vector each reached
   * `service.makeAdapter.ts`'s hand-built Arrow buffer and poisoned the
   * shared writer (`recovery_required` on the NEXT, unrelated
   * `publishRevision`). Each scenario below must instead become a normal,
   * closed `failed`/`embedder_bad_response` row, with the writer left
   * completely usable for the very next call.
   */
  const scenarios: Array<{ label: string; embedderMode: "short-batch" | "wrong-dims" | "nan-values" }> = [
    { label: "fewer vectors than texts requested", embedderMode: "short-batch" },
    { label: "vectors of the wrong width", embedderMode: "wrong-dims" },
    { label: "a vector containing a non-finite value", embedderMode: "nan-values" },
  ];
  for (const { label, embedderMode } of scenarios) {
    test(`${label} -> embedder_bad_response, never a poisoned writer`, async () => {
      const fixture = await createFixture([ALPHA]);
      try {
        const seeded = fixture.workspaces[ALPHA]!;
        const nodeA = pad(`ew-bad-${embedderMode}`);
        const nodeB = pad(`ew-bad2-${embedderMode}`);
        const revA = pad(`ew-badr-${embedderMode}`);
        const revB = pad(`ew-badr2-${embedderMode}`);
        const parsed = await drive(
          fixture.datasetRoot,
          [
            publish(seeded, nodeA, "op-ew-bad-1"),
            ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
            embed(),
            listChunks(revA),
            // An unrelated publish AFTER the bad response must still
            // succeed -- proof the shared writer was never poisoned.
            publish(seeded, nodeB, "op-ew-bad-2"),
          ],
          { revisionIds: [revA, revB], embedderMode },
        );
        expect(parsed.op0.value.outcome).toBe("accepted");
        const embedResult = parsed.op2;
        expect(embedResult.ok, JSON.stringify(embedResult)).toBe(true);
        expect(embedResult.value).toEqual({
          attempted: 1,
          embedded: 0,
          reused: 0,
          failed: 1,
          remaining: 1,
          skipped: 0,
          blocked: null,
        });

        const listed = parsed.op3.value;
        expect(listed).toHaveLength(1);
        expect(listed[0].status).toBe("failed");
        expect(listed[0].error_code).toBe("embedder_bad_response");

        const followUp = parsed.op4;
        expect(followUp.ok, JSON.stringify(followUp)).toBe(true);
        expect(followUp.value.outcome).toBe("accepted");
      } finally {
        await fixture.cleanup();
      }
    }, TEST_TIMEOUT_MS);
  }
});

describe("embedPendingChunks: a failed attempt retries and converges on ready", () => {
  test("first call fails (embedder_bad_response, attempts=1), second call succeeds (ready, attempts=2)", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-nodeC");
      const revA = pad("ew-revC");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-ew-c1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          embed(),
          listChunks(revA),
          embed(),
          listChunks(revA),
        ],
        { revisionIds: [revA], embedderMode: "reject-once" },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");

      const firstEmbed = parsed.op2;
      expect(firstEmbed.value).toEqual({ attempted: 1, embedded: 0, reused: 0, failed: 1, remaining: 1, skipped: 0, blocked: null });
      const afterFirst = parsed.op3.value;
      expect(afterFirst[0].status).toBe("failed");
      expect(afterFirst[0].attempts).toBe("1");
      expect(afterFirst[0].error_code).toBe("embedder_bad_response");

      const secondEmbed = parsed.op4;
      expect(secondEmbed.value).toEqual({ attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null });
      const afterSecond = parsed.op5.value;
      expect(afterSecond[0].status).toBe("ready");
      expect(afterSecond[0].attempts).toBe("2");
      expect(afterSecond[0].error_code).toBeNull();

      expect(parsed.embedCalls).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("embedPendingChunks: content-hash reuse costs zero embedder calls", () => {
  test("embedding a second node with byte-identical chunk text reuses the first node's vector", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-nodeD1");
      const nodeB = pad("ew-nodeD2");
      const revA = pad("ew-revD1");
      const revB = pad("ew-revD2");
      // publishRevision defaults ("a title" / "a body") are IDENTICAL for
      // both nodes, so their single chunk's content_hash matches exactly.
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-ew-d1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          embed(), // embeds nodeA's chunk for real: 1 embedder call.
          publish(seeded, nodeB, "op-ew-d2"),
          ctx("indexRevisionChunks", indexRequest(nodeB, revB)),
          embed(), // must reuse nodeA's vector: 0 more embedder calls.
          listChunks(revB),
        ],
        { revisionIds: [revA, revB], embedderMode: "fixed" },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      const firstEmbed = parsed.op2;
      expect(firstEmbed.value).toEqual({ attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null });

      const secondEmbed = parsed.op5;
      expect(secondEmbed.value).toEqual({ attempted: 1, embedded: 0, reused: 1, failed: 0, remaining: 0, skipped: 0, blocked: null });

      const listedB = parsed.op6.value;
      expect(listedB[0].status).toBe("ready");
      // Exactly one real embedder call across the whole run -- the second
      // node's chunk was satisfied entirely by reuse.
      expect(parsed.embedCalls).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("embedPendingChunks: no embedder configured fails closed, never a network call", () => {
  test("embedder_unavailable, attempts=1, and no fetch was ever attempted", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-nodeE");
      const revA = pad("ew-revE");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-ew-e1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          embed(),
          listChunks(revA),
        ],
        { revisionIds: [revA], embedderMode: "none" },
      );
      const result = parsed.op2;
      expect(result.value).toEqual({ attempted: 1, embedded: 0, reused: 0, failed: 1, remaining: 1, skipped: 0, blocked: null });
      const listed = parsed.op3.value;
      expect(listed[0].status).toBe("failed");
      expect(listed[0].error_code).toBe("embedder_unavailable");
      expect(parsed.embedCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("embedPendingChunks: the retry budget is bounded", () => {
  test(`a row that always fails stops being retried after ${MAX_EMBED_ATTEMPTS} attempts`, async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-nodeF");
      const revA = pad("ew-revF");
      const ops = [publish(seeded, nodeA, "op-ew-f1"), ctx("indexRevisionChunks", indexRequest(nodeA, revA))];
      for (let i = 0; i < MAX_EMBED_ATTEMPTS + 1; i++) ops.push(embed());
      const parsed = await drive(fixture.datasetRoot, ops, { revisionIds: [revA], embedderMode: "always-fail" });
      expect(parsed.op0.value.outcome).toBe("accepted");
      for (let i = 0; i < MAX_EMBED_ATTEMPTS; i++) {
        const result = parsed[`op${2 + i}`];
        expect(result.value.attempted, `attempt ${i + 1}`).toBe(1);
        expect(result.value.failed, `attempt ${i + 1}`).toBe(1);
      }
      // The (MAX_EMBED_ATTEMPTS + 1)th call finds nothing left to retry.
      const last = parsed[`op${2 + MAX_EMBED_ATTEMPTS}`];
      expect(last.value).toEqual({ attempted: 0, embedded: 0, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null });
      expect(parsed.embedCalls).toHaveLength(MAX_EMBED_ATTEMPTS);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("R8: index first, embed later, like backfill -- the whole loop, made real", () => {
  test("publishRevision -> indexRevisionChunks -> embedPendingChunks -> getSearchFreshness shows ready", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("ew-nodeG");
      const revA = pad("ew-revG");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-ew-g1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          freshness(),
          embed(),
          freshness(),
        ],
        { revisionIds: [revA], embedderMode: "fixed" },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.outcome).toBe("indexed");

      const before = parsed.op2.value;
      expect(before.vectors).toMatchObject({ pending: 1, ready: 0, failed: 0 });

      const embedded = parsed.op3.value;
      expect(embedded).toEqual({ attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null });

      const after = parsed.op4.value;
      expect(after.vectors).toMatchObject({ pending: 0, ready: 1, failed: 0 });
      expect(after.vectors.last_attempt_at).not.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
