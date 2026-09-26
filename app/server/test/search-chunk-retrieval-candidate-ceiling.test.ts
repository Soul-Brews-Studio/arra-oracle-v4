/**
 * #30 / #10 keyword retrieval: WHERE R22's isolation ends, measured at the
 * real bound (docs/overnight/DECISIONS.md R22, "Known residual").
 *
 * The keyword path reads a workspace's candidate chunks -- every chunk of it
 * sharing a trigram with the query -- in ONE read of up to
 * `FTS_CANDIDATE_CEILING` (4096), orders them all by R22 and only then keeps
 * `limit` (`search-chunk-retrieval-overfetch-bound.test.ts` proves what that
 * buys below the ceiling). Past the ceiling the read holds BM25's top 4096,
 * and BM25 alone decides which matches are read at all. This file builds that
 * state on purpose:
 *
 *   X    the query once, then 960 characters sharing none of its trigrams:
 *        a real match, and a weak BM25 candidate (every query trigram once).
 *   BIG  one node whose head never holds the query but whose every chunk holds
 *        every trigram of it, many times ("abcxybcxyz"): a strong BM25
 *        candidate that is never an answer. Each revision is ~890 chunks, and
 *        a stale revision's chunks stay candidates.
 *
 * With 4 BIG revisions (3565 candidate chunks) the read comes back short and
 * X is found, whatever BM25 thinks of it. The 5th revision takes ALPHA past
 * the ceiling: the read comes back full, every row of it a BIG chunk that
 * outscores X, and X -- still ALPHA's only match -- is no longer answered.
 * Nothing but ALPHA wrote; BM25's statistics are corpus-wide, so past this
 * line another workspace's writes can move the same pick (the R21/R22 repros
 * measured exactly that on the index these rows share). A per-workspace
 * index closes it.
 *
 * The payload is megabytes of text, past what argv can carry, so it goes to
 * the child as `@<file>` in a directory this test owns.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated } from "./helpers/publication-fixture";
import { FTS_CANDIDATE_CEILING } from "../src/fts/fts";
import { CHUNKER_VERSION, activeEmbeddingProfileId } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const PROFILE = activeEmbeddingProfileId();
const QUERY = "abcxyz";
/** Every trigram of QUERY (abc, bcx, cxy, xyz), and never QUERY itself. */
const UNIT = "abcxybcxyz ";
/** ~891,000 characters: ~891 chunks, inside the 1 MiB request cap. */
const BIG_BODY = UNIT.repeat(81_000);
const BIG_REVISIONS = 5;

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-retrieval.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const X = pad("ceilX");
const BIG = pad("ceilBig");

type Read = { source: string; asked: number; got: number };
type Spied = { value: { hits: { node_id: string }[] }; reads: Read[] };

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

describe("#30 / #10 R22's candidate ceiling, measured", () => {
  runIt(
    `below ${FTS_CANDIDATE_CEILING} candidate chunks every one is read and X is answered; past it BM25's pick drops X`,
    async () => {
      const fixture = await createFixture([ALPHA]);
      cleanups.push(fixture.cleanup);
      const dir = await mkdtemp(join(tmpdir(), "r22-ceiling-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));

      const ops: unknown[] = [];
      const revisionIds: string[] = [];
      const publish = (node: string, revision: string, body: string, base: string | null) => {
        revisionIds.push(revision);
        ops.push({
          label: `pub_${revision}`,
          facade: "publication",
          method: "publishRevision",
          request: { operation_id: `op-${revision}`, content: revisionEnvelope(ALPHA, fixture.workspaces[ALPHA]!, node, { title: "t", body, base_revision_id: base }) },
        });
        ops.push({
          label: `idx_${revision}`,
          facade: "context",
          method: "indexRevisionChunks",
          request: { workspace_name: ALPHA, node_id: node, revision_id: revision, chunker_version: CHUNKER_VERSION, embedding_profile: { name: PROFILE, dims: 384 } },
        });
      };
      publish(X, pad("ceilXrev"), `${QUERY} ${"mmm ".repeat(240)}`, null);
      let base: string | null = null;
      for (let i = 0; i < BIG_REVISIONS; i++) {
        const revision = pad(`ceilBigRev${i}`);
        publish(BIG, revision, `${BIG_BODY}v${i}`, base);
        base = revision;
        ops.push({ label: `after_${i + 1}`, facade: "harness", method: "spyKeyword", request: { workspace_name: ALPHA, query: QUERY, limit: 50 } });
      }

      const file = join(dir, "payload.json");
      await Bun.write(file, JSON.stringify({ ops, revisionIds, embedderProfile: PROFILE, queryVectors: {} }));
      const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, `@${file}`], { deadlineMs: TIMEOUT_MS - 10_000 });
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      const out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
      for (const op of ops as { label: string }[]) expect(out[op.label], `${op.label}: ${JSON.stringify(out[op.label])?.slice(0, 400)}`).toMatchObject({ ok: true });
      const spied = (i: number) => out[`after_${i}`].value as Spied;

      // Up to 4 BIG revisions: one read, asked for the ceiling, came back
      // short -- every candidate read -- and X, the only match, is answered.
      for (let i = 1; i < BIG_REVISIONS; i++) {
        const { value, reads } = spied(i);
        expect(reads, `after_${i}`).toHaveLength(1);
        expect(reads[0], `after_${i}`).toMatchObject({ source: "index", asked: FTS_CANDIDATE_CEILING });
        expect(reads[0]!.got, `after_${i}`).toBeLessThan(FTS_CANDIDATE_CEILING);
        expect(value.hits.map((hit) => hit.node_id), `after_${i}`).toEqual([X]);
      }
      // The 5th takes ALPHA past the ceiling: the read comes back FULL, BM25
      // filled it with BIG chunks, and X is not answered. The residual.
      const past = spied(BIG_REVISIONS);
      expect(past.reads).toEqual([{ source: "index", asked: FTS_CANDIDATE_CEILING, got: FTS_CANDIDATE_CEILING }]);
      expect(past.value.hits).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
