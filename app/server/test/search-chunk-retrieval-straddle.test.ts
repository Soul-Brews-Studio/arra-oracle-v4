/**
 * #30 keyword retrieval (overnight R7 #30 part + R14) over text LONGER THAN ONE
 * CHUNK, on a real writer-gated dataset (same child as
 * `search-chunk-retrieval.test.ts`).
 *
 * `chunkText` cuts a head revision's text (`title\n\nbody`) every 1000 UTF-16
 * code units, with no overlap. The keyword contract is about the NODE's head
 * text, not one chunk's, so each case below is a literal occurrence the head
 * text holds but no single chunk does:
 *
 * - STRADDLE: body = 995 x "a" + "หลงลืม tail", so the text reads
 *   `t\n\n aaa…aหล | งลืม tail` -- chunk 0 ends "หล", chunk 1 starts "งลืม".
 *   หลงลืม (6 code points) is found by the trigram index through chunk 1 and
 *   must survive the substring re-check; หลง (3) shares NO trigram with either
 *   chunk, so only the seam scan can find it; ลง (2) is the short-query scan
 *   across the seam.
 * - SEAM4: 995 x "b" + "wxyz end": wxyz splits 2+2, again no whole trigram in
 *   either chunk.
 * - LONG: body = "abcdefghij" x 110 (1100 code units, two chunks): the exact
 *   1100-character query, and its 999-character prefix, are each found.
 * - TITLE ONLY: กุญแจบ้าน is in the title and nowhere in the body. The head
 *   text is `title\n\nbody`, so the node answers.
 *
 * And one case the head text must REFUSE, which only the whole-text re-check
 * can refuse:
 *
 * - SEAM FALSE: body = 993 x "c" + "ความรัก งามทรงจำ", so chunk 0 is full
 *   length and ends "ความ", chunk 1 starts "รัก". The text holds EVERY trigram
 *   of ความทรงจำ (the measured ngram over-match: ความทรงจำ -> ความรัก) but not
 *   the word. Chunk 0 is a candidate on both paths, and the pre-filter
 *   (`chunkMayHoldQuery`) must keep it -- a full chunk ending with a proper
 *   prefix of the query may be the first half of a cut occurrence. Only the
 *   head text shows the next chunk does not finish it.
 *
 * Every case is asked twice: through the index (`match: "ngram"`), then with
 * the index dropped (`substring_scan`, `index_unavailable`), which has the same
 * seams to cross. หลงทาง is an over-match inside ONE chunk: it straddles
 * nothing and is contained nowhere, so it stays [] -- there, the chunk-local
 * pre-filter already drops it before any read.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated } from "./helpers/publication-fixture";
import { CHUNKER_VERSION, activeEmbeddingProfileId, chunkMayHoldQuery, chunkSourceText, chunkText, deriveChunkId } from "../src/publication/search-chunk";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = testTimeout(180_000);
const ALPHA = "alpha-workspace";
// #30 R7 (search-embed): the closed registry accepts only its active id.
const PROFILE = activeEmbeddingProfileId();

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-retrieval.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const LONG = "abcdefghij".repeat(110);
const NODES = {
  control: { id: pad("stControl"), rev: pad("revControl"), title: "ctl", body: "ฉันหลงลืมกุญแจ" },
  straddle: { id: pad("stStraddle"), rev: pad("revStraddle"), title: "t", body: `${"a".repeat(995)}หลงลืม tail` },
  seam4: { id: pad("stSeam4"), rev: pad("revSeam4"), title: "t", body: `${"b".repeat(995)}wxyz end` },
  long: { id: pad("stLong"), rev: pad("revLong"), title: "long", body: LONG },
  seamFalse: { id: pad("stSeamFalse"), rev: pad("revSeamFalse"), title: "t", body: `${"c".repeat(993)}ความรัก งามทรงจำ` },
  titleOnly: { id: pad("stTitleOnly"), rev: pad("revTitleOnly"), title: "กุญแจบ้าน", body: "the body never names it" },
};
const REVISIONS = Object.values(NODES).map((node) => node.rev);
/** Chunks each node's head text is cut into. */
const CHUNKS: Record<keyof typeof NODES, number> = { control: 1, straddle: 2, seam4: 2, long: 2, seamFalse: 2, titleOnly: 1 };
const trigrams = (text: string) => {
  const points = [...text];
  return points.slice(2).map((_, i) => points.slice(i, i + 3).join(""));
};
const chunkIds = (rev: string, count: number) =>
  Array.from({ length: count }, (_, i) => deriveChunkId(rev, CHUNKER_VERSION, PROFILE, BigInt(i)));

const QUERIES = {
  whole: "หลงลืม",
  seam3: "หลง",
  inside: "ลืม",
  short: "ลง",
  seam4: "wxyz",
  long: LONG,
  prefix: LONG.slice(0, 999),
  control: "หลงทาง",
  seamFalse: "ความทรงจำ",
  titleOnly: "กุญแจบ้าน",
} as const;

type Hit = { node_id: string; revision_id: string; snippet: string; chunk_ids: string[]; match: string; score: number | null };
let out: Record<string, any> = {};
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});
const ok = (label: string) => {
  expect(out[label], `${label}: ${JSON.stringify(out[label])?.slice(0, 600)}`).toMatchObject({ ok: true });
  return out[label].value;
};
const nodes = (label: string) => (ok(label).hits as Hit[]).map((hit) => hit.node_id);
/** Label prefixes: through the index, then with it dropped. */
const PATHS = ["ix", "scan"] as const;

describe("#30 keyword retrieval across chunk boundaries (real gated dataset)", () => {
  runIt(
    "setup: the straddle, seam, long and seam-false nodes are each cut into two chunks",
    async () => {
      // The premise, checked on the chunker itself rather than assumed.
      for (const [key, node] of Object.entries(NODES)) {
        expect(chunkText(chunkSourceText(node.title, node.body)), key).toHaveLength(CHUNKS[key as keyof typeof NODES]);
      }
      const [first, second] = chunkText(`t\n\n${NODES.straddle.body}`);
      expect(first!.endsWith("หล") && second!.startsWith("งลืม")).toBe(true);
      expect(first!.includes("หลง") || second!.includes("หลง")).toBe(false);
      // SEAM FALSE: every trigram of the query is in the head text, the query
      // is not, and the pre-filter keeps chunk 0 -- so nothing before the
      // whole-text re-check can tell this node from a real cut occurrence.
      const falseText = chunkSourceText(NODES.seamFalse.title, NODES.seamFalse.body);
      const [falseHead, falseTail] = chunkText(falseText);
      expect(falseHead!.endsWith("ความ") && falseTail!.startsWith("รัก")).toBe(true);
      expect(trigrams(QUERIES.seamFalse).filter((gram) => !falseText.includes(gram))).toEqual([]);
      expect(falseText.includes(QUERIES.seamFalse)).toBe(false);
      expect(chunkMayHoldQuery(falseHead!, 0n, QUERIES.seamFalse)).toBe(true);
      expect(NODES.titleOnly.body.includes(QUERIES.titleOnly)).toBe(false);

      const fixture = await createFixture([ALPHA]);
      cleanups.push(fixture.cleanup);
      const alpha = fixture.workspaces[ALPHA]!;
      const ops: unknown[] = [];
      for (const [key, node] of Object.entries(NODES)) {
        ops.push({
          label: `pub_${key}`,
          facade: "publication",
          method: "publishRevision",
          request: { operation_id: `op-${key}`, content: revisionEnvelope(ALPHA, alpha, node.id, { title: node.title, body: node.body }) },
        });
      }
      for (const [key, node] of Object.entries(NODES)) {
        ops.push({
          label: `idx_${key}`,
          facade: "context",
          method: "indexRevisionChunks",
          request: {
            workspace_name: ALPHA,
            node_id: node.id,
            revision_id: node.rev,
            chunker_version: CHUNKER_VERSION,
            embedding_profile: { name: PROFILE, dims: 384 },
          },
        });
      }
      const ask = (prefix: string) => {
        for (const [key, query] of Object.entries(QUERIES)) {
          ops.push({ label: `${prefix}_${key}`, facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: ALPHA, query } });
        }
        // What the candidate query itself returned for SEAM FALSE, before any re-check.
        ops.push({ label: `${prefix}_spy_seamFalse`, facade: "harness", method: "spyKeyword", request: { workspace_name: ALPHA, query: QUERIES.seamFalse } });
      };
      ask("ix");
      ops.push({ label: "drop", facade: "harness", method: "dropIndices" });
      ask("scan");

      const result = await runGated(
        fixture.datasetRoot,
        CHILD,
        [fixture.datasetRoot, JSON.stringify({ ops, revisionIds: REVISIONS, embedderProfile: PROFILE, queryVectors: {} })],
        { deadlineMs: TIMEOUT_MS - 10_000 },
      );
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
      for (const key of Object.keys(NODES)) {
        expect(ok(`pub_${key}`).revision_id).toBe(NODES[key as keyof typeof NODES].rev);
        expect(ok(`idx_${key}`).rows).toHaveLength(CHUNKS[key as keyof typeof NODES]);
      }
    },
    TIMEOUT_MS,
  );

  runIt("index path: an occurrence cut by a chunk boundary is still found, and says how", () => {
    expect(ok("ix_whole").match).toBe("ngram");
    expect(nodes("ix_whole").sort()).toEqual([NODES.control.id, NODES.straddle.id].sort());
    const straddle = (ok("ix_whole").hits as Hit[]).find((hit) => hit.node_id === NODES.straddle.id)!;
    // The snippet is cut from the head text, so it shows the whole occurrence.
    expect(straddle.snippet).toContain("หลงลืม");
    expect(straddle.revision_id).toBe(NODES.straddle.rev);
    expect(straddle.chunk_ids.every((id) => chunkIds(NODES.straddle.rev, 2).includes(id))).toBe(true);
    expect(nodes("ix_inside").sort()).toEqual([NODES.control.id, NODES.straddle.id].sort());

    // หลง: no chunk of the straddle node holds a trigram of it. The scored
    // index hit ranks first; the seam hit follows, unscored, and says it was a scan.
    const seam3 = ok("ix_seam3");
    expect(seam3.match).toBe("ngram");
    expect(nodes("ix_seam3")).toEqual([NODES.control.id, NODES.straddle.id]);
    expect(seam3.hits[0]).toMatchObject({ match: "ngram" });
    expect(typeof seam3.hits[0].score).toBe("number");
    expect(seam3.hits[1]).toMatchObject({ match: "substring_scan", score: null });
    expect(seam3.hits[1].snippet).toContain("หลงลืม");

    expect(nodes("ix_seam4")).toEqual([NODES.seam4.id]);
    expect(ok("ix_seam4").hits[0]).toMatchObject({ match: "substring_scan", score: null });

    expect(ok("ix_short")).toMatchObject({ match: "substring_scan", scan_reason: "short_query" });
    expect(nodes("ix_short")).toEqual([NODES.control.id, NODES.straddle.id].sort());
  });

  runIt("index path: a query longer than a chunk is found, whole or as a 999-character prefix", () => {
    expect(ok("ix_long").match).toBe("ngram");
    expect(nodes("ix_long")).toEqual([NODES.long.id]);
    expect(nodes("ix_prefix")).toEqual([NODES.long.id]);
    expect(ok("ix_long").hits[0].chunk_ids.length).toBeGreaterThan(0);
  });

  runIt("index path: an over-match inside one chunk (หลงทาง) stays out", () => {
    expect(ok("ix_control")).toMatchObject({ match: "ngram", hits: [] });
  });

  runIt("a seam over-match is a candidate the pre-filter keeps; only the head-text re-check refuses it, on both paths", () => {
    expect(ok("ix_seamFalse").match).toBe("ngram");
    expect(ok("ix_spy_seamFalse").value.match).toBe("ngram");
    expect(ok("scan_seamFalse").scan_reason).toBe("index_unavailable");
    expect(ok("scan_spy_seamFalse").value.scan_reason).toBe("index_unavailable");
    // The candidate query DID return it on both paths (chunk 0 holds ความ) ...
    for (const path of PATHS) expect(ok(`${path}_spy_seamFalse`).candidates, path).toContain(NODES.seamFalse.id);
    // ... and no answer does. One comparison, so a failure shows every path.
    const answers = Object.fromEntries(
      PATHS.flatMap((path) => [
        [path, nodes(`${path}_seamFalse`)],
        [`${path}_spy`, (ok(`${path}_spy_seamFalse`).value.hits as Hit[]).map((hit) => hit.node_id)],
      ]),
    );
    expect(answers).toEqual({ ix: [], ix_spy: [], scan: [], scan_spy: [] });
  });

  runIt("the head text includes the title: a query only the title holds answers, on both paths", () => {
    const answers = Object.fromEntries(PATHS.map((path) => [path, nodes(`${path}_titleOnly`)]));
    expect(answers).toEqual({ ix: [NODES.titleOnly.id], scan: [NODES.titleOnly.id] });
    for (const path of PATHS) expect(ok(`${path}_titleOnly`).hits[0].snippet, path).toContain(QUERIES.titleOnly);
  });

  runIt("scan path (no index): the same seams are crossed, and the same over-match is removed", () => {
    for (const key of ["whole", "seam3", "inside", "seam4", "long", "prefix", "control"]) {
      expect(ok(`scan_${key}`), key).toMatchObject({ match: "substring_scan", scan_reason: "index_unavailable" });
    }
    const both = [NODES.control.id, NODES.straddle.id].sort();
    expect(nodes("scan_whole")).toEqual(both);
    expect(nodes("scan_seam3")).toEqual(both);
    expect(nodes("scan_inside")).toEqual(both);
    expect(nodes("scan_short")).toEqual(both);
    expect(ok("scan_short").scan_reason).toBe("short_query");
    expect(nodes("scan_seam4")).toEqual([NODES.seam4.id]);
    expect(nodes("scan_long")).toEqual([NODES.long.id]);
    expect(nodes("scan_prefix")).toEqual([NODES.long.id]);
    expect(ok("scan_control").hits).toEqual([]);
    for (const hit of ok("scan_whole").hits as Hit[]) expect(hit).toMatchObject({ match: "substring_scan", score: null });
  });
});
