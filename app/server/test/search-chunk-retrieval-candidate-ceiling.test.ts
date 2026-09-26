/**
 * #30 / #10 keyword retrieval: WHERE R22's isolation ends, measured at the
 * real bound (docs/overnight/DECISIONS.md R22, "Known residual").
 *
 * The keyword path reads a workspace's candidate chunks -- every chunk of it
 * sharing a trigram with the query -- in ONE read of up to
 * `FTS_CANDIDATE_CEILING` (4096), orders them all by R22 and only then keeps
 * `limit` (`search-chunk-retrieval-overfetch-bound.test.ts` proves what that
 * buys below the ceiling). Past the ceiling the read holds BM25's top 4096,
 * and BM25 -- whose IDF is computed over the index EVERY workspace shares --
 * decides which matches are read at all. This file builds that state:
 *
 *   X    the query once, then "xyz" x 240: ALPHA's only match. Among ALPHA's
 *        own rows it is BM25's strongest candidate (the most of one query
 *        trigram in the shortest text).
 *   BIG  one ALPHA node whose head never holds the query, but whose every
 *        chunk holds all four of its trigrams, "abc" 150 times: a candidate
 *        that is never an answer. Each revision is ~890 chunks; a stale
 *        revision's chunks stay candidates.
 *   BETA two nodes of "xyz" repeated, never ALPHA candidates at all. Indexed
 *        (the writer's refresh rebuilds the shared index once they arrive),
 *        they make "xyz" common corpus-wide: its IDF collapses, and X, whose
 *        weight is "xyz", falls below every BIG chunk.
 *
 * With up to 4 BIG revisions (at most 3565 candidate chunks) the read comes
 * back short and X is answered, whatever BM25 thinks of it. The 5th takes
 * ALPHA past the ceiling: the read comes back full and X, still BM25's best,
 * is answered. Then BETA writes -- and ALPHA's answer loses X, with no ALPHA
 * write in between. That is the residual R22 names, at the real bound; a
 * per-workspace index closes it.
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
const BETA = "beta-workspace";
const PROFILE = activeEmbeddingProfileId();
const QUERY = "abcxyz";
/** 1000 characters holding abc (x150), bcx, cxy and xyz, and never QUERY. */
const UNIT = `${"abc ".repeat(150)}${"mmm ".repeat(97)}bcxy wxyz q `;
/** ~890 chunks per revision, inside the 1 MiB request cap. */
const UNITS = 890;
const BIG_REVISIONS = 5;
const BETA_NODES = 2;

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
    `below ${FTS_CANDIDATE_CEILING} candidate chunks every one is read; past it BETA-only writes move ALPHA's answer`,
    async () => {
      const fixture = await createFixture([ALPHA, BETA]);
      cleanups.push(fixture.cleanup);
      const dir = await mkdtemp(join(tmpdir(), "r22-ceiling-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));

      const ops: unknown[] = [];
      const revisionIds: string[] = [];
      const heads = new Map<string, string>();
      const publish = (workspace: string, node: string, body: string) => {
        const revision = pad(`ceilRev${revisionIds.length.toString().padStart(2, "0")}`);
        revisionIds.push(revision);
        ops.push({
          label: `pub_${revision}`,
          facade: "publication",
          method: "publishRevision",
          request: {
            operation_id: `op-${revision}`,
            content: revisionEnvelope(workspace, fixture.workspaces[workspace]!, node, { title: "t", body, base_revision_id: heads.get(node) ?? null }),
          },
        });
        ops.push({
          label: `idx_${revision}`,
          facade: "context",
          method: "indexRevisionChunks",
          request: { workspace_name: workspace, node_id: node, revision_id: revision, chunker_version: CHUNKER_VERSION, embedding_profile: { name: PROFILE, dims: 384 } },
        });
        heads.set(node, revision);
      };
      const search = (label: string) =>
        ops.push({ label, facade: "harness", method: "spyKeyword", request: { workspace_name: ALPHA, query: QUERY, limit: 50 } });

      publish(ALPHA, X, `${QUERY} ${"xyz ".repeat(240)}`);
      for (let i = 0; i < BIG_REVISIONS; i++) {
        publish(ALPHA, BIG, `${UNIT.repeat(UNITS)}v${i}`);
        search(`big_${i + 1}`);
      }
      for (let i = 0; i < BETA_NODES; i++) publish(BETA, pad(`ceilBeta${i}`), "xyz ".repeat(250 * UNITS));
      search("after_beta");

      const file = join(dir, "payload.json");
      await Bun.write(file, JSON.stringify({ ops, revisionIds, embedderProfile: PROFILE, queryVectors: {} }));
      const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, `@${file}`], { deadlineMs: TIMEOUT_MS - 10_000 });
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      const out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
      for (const op of ops as { label: string }[]) expect(out[op.label], `${op.label}: ${JSON.stringify(out[op.label])?.slice(0, 400)}`).toMatchObject({ ok: true });
      const spied = (label: string) => out[label].value as Spied;
      const answered = (label: string) => spied(label).value.hits.map((hit) => hit.node_id);

      // Up to 4 BIG revisions: one read, asked for the ceiling, came back
      // short -- every candidate read -- and X, the only match, is answered.
      for (let i = 1; i < BIG_REVISIONS; i++) {
        const { reads } = spied(`big_${i}`);
        expect(reads, `big_${i}`).toHaveLength(1);
        expect(reads[0], `big_${i}`).toMatchObject({ source: "index", asked: FTS_CANDIDATE_CEILING });
        expect(reads[0]!.got, `big_${i}`).toBeLessThan(FTS_CANDIDATE_CEILING);
        expect(answered(`big_${i}`), `big_${i}`).toEqual([X]);
      }
      // The 5th takes ALPHA past the ceiling: the read comes back FULL. X is
      // still BM25's best of ALPHA's rows, so it is read and answered ...
      const full = [{ source: "index", asked: FTS_CANDIDATE_CEILING, got: FTS_CANDIDATE_CEILING }];
      expect(spied(`big_${BIG_REVISIONS}`).reads).toEqual(full);
      expect(answered(`big_${BIG_REVISIONS}`)).toEqual([X]);
      // ... until BETA -- never an ALPHA candidate -- makes "xyz" common across
      // the shared index. BM25 now fills ALPHA's read with BIG chunks, and
      // ALPHA's only match is no longer answered. The residual, measured.
      expect(spied("after_beta").reads).toEqual(full);
      expect(answered("after_beta")).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
