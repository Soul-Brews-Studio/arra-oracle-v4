/**
 * #30 retrieval x #29 slice B, pinned at the overnight integration merge: both
 * knowledge searches apply the validity window at the REQUEST's `as_of`.
 *
 * The search-query slice was built before #29 slice B landed, so it asked
 * `getRecallEligibility` with no time and relied on the kernel's own clock
 * fallback. The merge threads the transport's request time through
 * (`registry.ts` -> `createSearchService` -> `currentEligibleChunks` ->
 * `recallEligibleNodeIds` -> `getRecallEligibility`), exactly as the registry
 * already did for `getRecallEligibility` itself (R7 #29: "the validity-window
 * as_of is supplied by the transport at request time"). This file proves the
 * threaded value is the one the window is judged at, on both searches, at the
 * half-open boundary instant, and that the live registry route applies it on
 * the READER bundle.
 *
 * Writes (publish, index, embed) run in the gated child; the searches run
 * in-process on a gateless reader, which is where the transport runs them.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { KNOWLEDGE_METHODS, type KnowledgeReaderBundle, type RequestAuthority } from "../src/knowledge/registry";
import { CHUNKER_VERSION, deriveChunkId } from "../src/publication/search-chunk";
import { openEvidenceReader } from "../src/publication/service";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const PROFILE = "all-minilm";
const DIMS = 384;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const E0 = (() => {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 1;
  return v;
})();

/** Valid until (exclusive) 2027-01-01; not valid before (inclusive) 2999-01-01. */
const VALID_TO = "2027-01-01T00:00:00.000Z";
const VALID_FROM = "2999-01-01T00:00:00.000Z";
const AT_TO = Date.parse(VALID_TO);
const AT_FROM = Date.parse(VALID_FROM);
const N = { until: pad("windowUntil"), from: pad("windowFrom") };
const R = { until: pad("revWindowUntil"), from: pad("revWindowFrom") };
const QUERY = "window-marker";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const keywordRequest = encode({ workspace_name: ALPHA, query: QUERY });
const semanticRequest = encode({ workspace_name: ALPHA, query: "q-e0" });
const nodesOf = (value: unknown) => ((value as { hits: Array<{ node_id: string }> }).hits ?? []).map((hit) => hit.node_id).sort();

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function seed(fixture: Fixture) {
  const alpha = fixture.workspaces[ALPHA]!;
  const ops: unknown[] = [];
  for (const [key, window] of [
    ["until", { valid_to: VALID_TO }],
    ["from", { valid_from: VALID_FROM }],
  ] as const) {
    ops.push({
      label: `pub_${key}`,
      facade: "publication",
      method: "publishRevision",
      request: {
        operation_id: `op-${key}`,
        content: revisionEnvelope(ALPHA, alpha, N[key], { title: `note ${key}`, body: `${QUERY} ${key}`, ...window }),
      },
    });
    ops.push({
      label: `idx_${key}`,
      facade: "context",
      method: "indexRevisionChunks",
      request: {
        workspace_name: ALPHA,
        node_id: N[key],
        revision_id: R[key],
        chunker_version: CHUNKER_VERSION,
        embedding_profile: { name: PROFILE, dims: DIMS },
      },
    });
    ops.push({
      label: `emb_${key}`,
      facade: "context",
      method: "writeChunkEmbedding",
      request: { workspace_name: ALPHA, id: deriveChunkId(R[key], CHUNKER_VERSION, PROFILE, 0n), embedding: E0 },
    });
  }
  const result = await runGated(
    fixture.datasetRoot,
    CHILD,
    [fixture.datasetRoot, JSON.stringify({ ops, revisionIds: [R.until, R.from], embedderProfile: PROFILE, queryVectors: {} })],
    { deadlineMs: TIMEOUT_MS - 10_000 },
  );
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  const out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!) as Record<string, { ok: boolean }>;
  for (const label of Object.keys(out).filter((l) => /^(pub|idx|emb)_/.test(l))) {
    expect(out[label]?.ok, `${label}: ${JSON.stringify(out[label]).slice(0, 500)}`).toBe(true);
  }
}

describe("#30 searches judge the #29 validity window at the request's as_of", () => {
  test(
    "keyword and semantic: the threaded as_of decides, at the half-open boundary, and the live registry route applies it on the reader",
    async () => {
      const fixture = await createFixture([ALPHA]);
      cleanups.push(fixture.cleanup);
      await seed(fixture);

      const reader = await openEvidenceReader(fixture.datasetRoot, { embedder: { profile: PROFILE, embed: async () => E0 } });
      const both = async (asOf: number) => ({
        keyword: nodesOf(await reader.context.searchKnowledgeKeyword(keywordRequest, asOf)),
        semantic: nodesOf(await reader.context.searchKnowledgeSemantic(semanticRequest, asOf)),
      });

      // 1 ms before valid_to: `until` is valid, `from` is not yet.
      expect(await both(AT_TO - 1)).toEqual({ keyword: [N.until], semantic: [N.until] });
      // AT valid_to (exclusive): `until` has expired, `from` is still not valid.
      expect(await both(AT_TO)).toEqual({ keyword: [], semantic: [] });
      // AT valid_from (inclusive): only `from` is valid.
      expect(await both(AT_FROM)).toEqual({ keyword: [N.from], semantic: [N.from] });

      // The live route: the registry hands the READER bundle a real request
      // time. `from` opens in 2999, so it is never an answer today.
      const live = { ...reader } as KnowledgeReaderBundle;
      const authority = {} as RequestAuthority;
      const viaRegistry = {
        keyword: nodesOf(await KNOWLEDGE_METHODS.searchKnowledgeKeyword!.call(live, keywordRequest, authority)),
        semantic: nodesOf(await KNOWLEDGE_METHODS.searchKnowledgeSemantic!.call(live, semanticRequest, authority)),
      };
      expect(viaRegistry.keyword).not.toContain(N.from);
      expect(viaRegistry.semantic).not.toContain(N.from);
    },
    TIMEOUT_MS,
  );
});
