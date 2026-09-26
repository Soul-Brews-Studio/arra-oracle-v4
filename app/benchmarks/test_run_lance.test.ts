// app/benchmarks/test_run_lance.test.ts -- tests for run_lance.ts (#7, R16/A3).
//
// SYNTHETIC fixtures only (fixtures/run-lance-v1/*.json), hand-authored, not
// held out, not evidence about retrieval quality -- they exercise the
// executor's plumbing against a REAL LanceDB, the same way the acceptor's
// probes did (see docs/overnight/DECISIONS.md R16, LANCEDB-FACTS.md).
//
// Every test uses a fresh mktemp LanceDB created and destroyed INSIDE
// `runLanceBenchmark` -- no fixture here touches app/.tmp, app/data, ~/, or
// any running service. The `vector` profile is stubbed from
// fixtures/run-lance-v1/vectors.json; nothing here calls Ollama, and one
// test proves it (`fetch` is spied and asserted uncalled).
//
// Run: bun test test_run_lance.test.ts

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { composeIndexedText, INDEXED_TEXT_COMPOSITION, type MethodRun, runLanceBenchmark, WORKSPACE_NAME } from "./run_lance";

/** Test-only narrowing helper: asserts a method ran (not a whole-method
 * `not_run` marker) and a specific query's outcome is a completed ranking
 * (not a per-query `error`), then returns that ranking as `string[]`. */
function ranking(run: MethodRun, queryId: string): string[] {
  if ("status" in run && run.status === "not_run") throw new Error(`expected method to have run, got not_run: ${run.reason}`);
  const outcome = (run as Record<string, unknown>)[queryId];
  if (!Array.isArray(outcome)) throw new Error(`expected a completed ranking for ${queryId}, got ${JSON.stringify(outcome)}`);
  return outcome as string[];
}

const FIXTURES = join(import.meta.dir, "fixtures", "run-lance-v1");
const CORPUS_PATH = join(FIXTURES, "corpus.json");
const QUERIES_PATH = join(FIXTURES, "queries.json");
const QRELS_PATH = join(FIXTURES, "qrels.json");
const VECTORS_PATH = join(FIXTURES, "vectors.json");

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("indexed text composition", () => {
  test("matches app/server/src/publication/service.indexRevisionChunks.ts:62 exactly", () => {
    expect(composeIndexedText("T", "B")).toBe("T\n\nB");
    expect(INDEXED_TEXT_COMPOSITION).toBe("${title}\n\n${body}");
  });
});

describe("thai inside-word discriminator (measured, matches LANCEDB-FACTS.md #3)", () => {
  test("icu finds nothing for a query that only occurs INSIDE a word; ngram3 finds it; literal is labelled literal", async () => {
    const { runs } = await runLanceBenchmark({
      corpusPath: CORPUS_PATH,
      queriesPath: QUERIES_PATH,
    });

    // "ลืม" occurs only inside "หลงลืม" in r1's body -- never as its own
    // ICU-segmented word.
    expect(runs.methods.icu).toMatchObject({ q_lum: [] });
    expect(runs.methods.ngram3).toMatchObject({ q_lum: ["r1"] });
    // literal_includes is an exact substring scan, not a "trigram" engine --
    // it also finds r1 here, but for a completely different reason (a raw
    // substring check, not tokenized BM25).
    expect(runs.methods.literal_includes).toMatchObject({ q_lum: ["r1"] });
  });
});

describe("title-only term is found under the search_chunks_v1 title+body composition", () => {
  test("a query that only appears in a document's TITLE hits under every profile that indexes composed text", async () => {
    const { runs } = await runLanceBenchmark({
      corpusPath: CORPUS_PATH,
      queriesPath: QUERIES_PATH,
    });

    // "ประชุม" appears only in r2's title ("ประชุมทีม"), never in its body.
    // This guards against the content-only drift the legacy `memories` FTS
    // index has (db.ts:111 indexes `content` only, not `name`/title).
    expect(ranking(runs.methods.icu, "q_title")).toContain("r2");
    expect(ranking(runs.methods.ngram3, "q_title")).toContain("r2");
    expect(ranking(runs.methods.literal_includes, "q_title")).toEqual(["r2"]);
  });
});

describe("manifest readback", () => {
  test("tokenizers.icu and tokenizers.ngram3 reflect the REAL index readback, not the requested options", async () => {
    const { manifest } = await runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH });

    const tokenizers = manifest.tokenizers as Record<string, Record<string, unknown>>;
    // Full equality, not a `toMatchObject` subset -- measured once against a
    // real index (see .tmp/probe in this slice's session) and pinned in
    // full, including fields no test previously asserted
    // (ascii_folding/lower_case/with_position/etc), so a hard-coded partial
    // dict standing in for the real `listIndices()` readback fails here.
    expect(tokenizers.icu).toEqual({
      ascii_folding: true,
      base_tokenizer: "icu",
      block_size: 128,
      custom_stop_words: null,
      index_operators: false,
      lance_tokenizer: "text",
      language: "English",
      lower_case: true,
      max_ngram_length: 3,
      max_token_length: 40,
      min_ngram_length: 3,
      prefix_only: false,
      preserve_original: false,
      remove_stop_words: true,
      split_identifiers: false,
      split_on_numerics: false,
      stem: true,
      with_position: false,
    });
    // ngram3 explicitly disables stemming and stop-word removal, per R14 --
    // every other field still comes from LanceDB's own default readback.
    expect(tokenizers.ngram3).toEqual({
      ascii_folding: true,
      base_tokenizer: "ngram",
      block_size: 128,
      custom_stop_words: null,
      index_operators: false,
      lance_tokenizer: "text",
      language: "English",
      lower_case: true,
      max_ngram_length: 3,
      max_token_length: 40,
      min_ngram_length: 3,
      prefix_only: false,
      preserve_original: false,
      remove_stop_words: false,
      split_identifiers: false,
      split_on_numerics: false,
      stem: false,
      with_position: false,
    });
  });

  test("engine versions are read from app/server/node_modules, not hand-typed", async () => {
    const { manifest } = await runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH });
    expect(manifest.engine).toEqual({ "@lancedb/lancedb": "0.38.0", "apache-arrow": "18.1.0" });
  });

  test("candidate_limit and eligibility_filter are recorded and identical for every method", async () => {
    const { manifest } = await runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH });
    expect(manifest.candidate_limit).toBe(3); // corpus size
    expect(manifest.eligibility_filter).toBe(`workspace_name = '${WORKSPACE_NAME}'`);
  });

  test("rrf k and tie rule match harness_metrics.py exactly", async () => {
    const { manifest } = await runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH });
    expect(manifest.rrf).toEqual({ k: 60, tie_rule: "utf16_code_unit" });
  });

  test("artifact_sha256 matches the real bytes read from disk", async () => {
    const { manifest } = await runLanceBenchmark({
      corpusPath: CORPUS_PATH,
      queriesPath: QUERIES_PATH,
      qrelsPath: QRELS_PATH,
      vectorsPath: VECTORS_PATH,
    });
    expect(manifest.artifact_sha256).toEqual({
      corpus: sha256OfFile(CORPUS_PATH),
      queries: sha256OfFile(QUERIES_PATH),
      qrels: sha256OfFile(QRELS_PATH),
      vectors: sha256OfFile(VECTORS_PATH),
    });
  });
});

describe("vector profile: not_run without frozen vectors, no model call ever", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: unknown[] = [];

  beforeEach(() => {
    fetchCalls = [];
    // @ts-expect-error -- test spy
    globalThis.fetch = (...args: unknown[]) => {
      fetchCalls.push(args);
      throw new Error("run_lance must never call fetch (no Ollama in tests)");
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("with no vectors file: vector is not_run with a reason, embedding manifest is not_run, and fetch is never called", async () => {
    const previousOllamaUrl = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = "http://127.0.0.1:1/deliberately-unreachable";
    try {
      const { runs, manifest } = await runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH });

      expect(runs.methods.vector).toMatchObject({ status: "not_run" });
      expect((runs.methods.vector as { reason: string }).reason).toContain("no frozen vectors");
      expect(manifest.embedding).toMatchObject({ status: "not_run", model: null, ollama_digest: null, dims: null, request_options: null });
      expect(fetchCalls).toHaveLength(0);
    } finally {
      if (previousOllamaUrl === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previousOllamaUrl;
    }
  });

  test("with a frozen vectors file: vector profile runs over precomputed vectors, still with zero fetch calls", async () => {
    const { runs, manifest } = await runLanceBenchmark({
      corpusPath: CORPUS_PATH,
      queriesPath: QUERIES_PATH,
      vectorsPath: VECTORS_PATH,
    });

    expect(Object.keys(runs.methods.vector)).toEqual(["q_lum", "q_title", "q_grocery"]);
    // Exact order, hand-computed L2 distance from fixtures/run-lance-v1/vectors.json
    // (not `arrayContaining`, which every permutation of a 3-row corpus at
    // limit 3 satisfies and pins nothing): q_lum is nearest r1, then r2, then
    // r3; q_title is nearest r2; q_grocery is nearest r3. Reversing the
    // ranking, or searching with the same constant vector for every query
    // instead of each query's own vector, changes at least one of these three.
    expect(ranking(runs.methods.vector, "q_lum")).toEqual(["r1", "r2", "r3"]);
    expect(ranking(runs.methods.vector, "q_title")).toEqual(["r2", "r1", "r3"]);
    expect(ranking(runs.methods.vector, "q_grocery")).toEqual(["r3", "r2", "r1"]);
    expect(manifest.embedding).toMatchObject({
      status: "frozen",
      model: "stub-test-model",
      dims: 3,
      distance: "l2",
      request_options: { truncate: false, keep_alive: "5m" }, // A1(c): echoed from vectors.json, not invented
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("distanceType is actually applied, not silently defaulted to L2: cosine flips q_lum's ranking", async () => {
    // Same corpus vectors as fixtures/run-lance-v1/vectors.json, but labelled
    // "cosine" instead of "l2". Hand-computed cosine distance for q_lum
    // against r1/r2/r3 orders r3 ahead of r2 -- the OPPOSITE of the L2 order
    // asserted above -- so this fails unless run_lance actually calls
    // `.distanceType("cosine")` rather than always running LanceDB's L2
    // default and just relabelling the manifest.
    const scratchDir = mkdtempSync(join(tmpdir(), "arra-bench-test-fixture-"));
    try {
      const cosineVectors = { ...JSON.parse(readFileSync(VECTORS_PATH, "utf8")), distance: "cosine" };
      const cosineVectorsPath = join(scratchDir, "vectors-cosine.json");
      writeFileSync(cosineVectorsPath, JSON.stringify(cosineVectors));

      const { runs, manifest } = await runLanceBenchmark({
        corpusPath: CORPUS_PATH,
        queriesPath: QUERIES_PATH,
        vectorsPath: cosineVectorsPath,
      });

      expect(manifest.embedding).toMatchObject({ distance: "cosine", dims: 3 });
      expect(ranking(runs.methods.vector, "q_lum")).toEqual(["r1", "r3", "r2"]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("refuses a vectors file whose declared dims does not match the actual corpus vector length", async () => {
    // The exact shape of the adversarial repro that found this bug: only
    // `dims` is changed (999, a lie), the real corpus/query vectors stay
    // 3-wide. A manifest that echoed dims:999 here would be false.
    const scratchDir = mkdtempSync(join(tmpdir(), "arra-bench-test-fixture-"));
    try {
      const lyingVectors = { ...JSON.parse(readFileSync(VECTORS_PATH, "utf8")), dims: 999 };
      const lyingVectorsPath = join(scratchDir, "vectors-lying-dims.json");
      writeFileSync(lyingVectorsPath, JSON.stringify(lyingVectors));

      await expect(
        runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH, vectorsPath: lyingVectorsPath }),
      ).rejects.toThrow(/dims/);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("refuses an unsupported distance value instead of silently running LanceDB's default", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "arra-bench-test-fixture-"));
    try {
      const badVectors = { ...JSON.parse(readFileSync(VECTORS_PATH, "utf8")), distance: "manhattan" };
      const badVectorsPath = join(scratchDir, "vectors-bad-distance.json");
      writeFileSync(badVectorsPath, JSON.stringify(badVectors));

      await expect(
        runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH, vectorsPath: badVectorsPath }),
      ).rejects.toThrow(/distance/);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("a single wrong-dim query vector errors for that query only -- the rest of the method still runs", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "arra-bench-test-fixture-"));
    try {
      const raw = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
      raw.queries.q_lum = [0.1, 0.2]; // 2 floats, not 3 -- everything else stays valid
      const badQueryVectorPath = join(scratchDir, "vectors-bad-query-dims.json");
      writeFileSync(badQueryVectorPath, JSON.stringify(raw));

      const { runs } = await runLanceBenchmark({
        corpusPath: CORPUS_PATH,
        queriesPath: QUERIES_PATH,
        vectorsPath: badQueryVectorPath,
      });

      const vectorRun = runs.methods.vector as Record<string, unknown>;
      expect(vectorRun.q_lum).toMatchObject({ status: "error" });
      // q_title and q_grocery are untouched by q_lum's bad vector.
      expect(ranking(runs.methods.vector, "q_title")).toEqual(["r2", "r1", "r3"]);
      expect(ranking(runs.methods.vector, "q_grocery")).toEqual(["r3", "r2", "r1"]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("literal_includes vs ngram3 diverge on tokenized-but-not-substring hits (measured, matches LANCEDB-FACTS.md #3)", () => {
  // A dedicated scratch corpus/queries, kept separate from fixtures/run-lance-v1
  // so it never perturbs that fixture's other assertions (candidate_limit,
  // artifact_sha256, etc). Measured directly against a real LanceDB before
  // writing these expectations (see .tmp/probe in this slice's session).
  let scratchDir: string;
  let corpusPath: string;
  let queriesPath: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "arra-bench-test-fixture-"));
    corpusPath = join(scratchDir, "corpus.json");
    queriesPath = join(scratchDir, "queries.json");
    writeFileSync(
      corpusPath,
      JSON.stringify({
        documents: [
          { id: "th1", title: "เรื่องเก่า", type: "note", body: "ฉันหลงลืมเรื่องนี้ไปนานแล้ว", lang: "th" },
          { id: "milk_exact", title: "pantry note", type: "note", body: "milk and eggs are on the list", lang: "en" },
          { id: "milk_tokens", title: "smoothie note", type: "note", body: "almond milk pairs well, and oat milk too", lang: "en" },
          { id: "unrelated", title: "clouds", type: "note", body: "a completely unrelated sentence about clouds", lang: "en" },
        ],
      }),
    );
    writeFileSync(
      queriesPath,
      JSON.stringify({
        queries: [
          { id: "q_partial_thai", text: "ลื", lang: "th", purpose: "literal" },
          { id: "q_milk_and", text: "milk and", lang: "en", purpose: "literal" },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test("a query shorter than one ngram(3,3) token: literal finds the substring, ngram3 finds nothing", async () => {
    const { runs } = await runLanceBenchmark({ corpusPath, queriesPath });
    expect(ranking(runs.methods.literal_includes, "q_partial_thai")).toEqual(["th1"]);
    expect(ranking(runs.methods.ngram3, "q_partial_thai")).toEqual([]);
  });

  test("literal_includes returns ONLY the exact substring match; ngram3 also returns a document that merely shares trigrams", async () => {
    const { runs } = await runLanceBenchmark({ corpusPath, queriesPath });
    const literal = ranking(runs.methods.literal_includes, "q_milk_and");
    const ngram3 = ranking(runs.methods.ngram3, "q_milk_and");

    expect(literal).toEqual(["milk_exact"]);
    expect(literal).not.toContain("milk_tokens");
    expect(ngram3).toContain("milk_tokens"); // shares "mil"/"ilk"/"and" trigrams without the contiguous phrase
    expect(ngram3).not.toEqual(literal); // the two profiles must not collapse into the same engine
  });
});

describe("replay is byte-identical", () => {
  test("running the executor twice on the same inputs produces the same runs.json bytes", async () => {
    const first = await runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH, vectorsPath: VECTORS_PATH });
    const second = await runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: QUERIES_PATH, vectorsPath: VECTORS_PATH });

    expect(JSON.stringify(first.runs)).toBe(JSON.stringify(second.runs));
  });
});

describe("input validation", () => {
  test("an empty corpus is refused before any LanceDB is opened", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "arra-bench-test-fixture-"));
    const empty = join(scratchDir, "empty-corpus.json");
    writeFileSync(empty, JSON.stringify({ documents: [] }));
    try {
      await expect(runLanceBenchmark({ corpusPath: empty, queriesPath: QUERIES_PATH })).rejects.toThrow(/non-empty/);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("a duplicate query id is refused rather than silently overwriting the earlier query's result", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "arra-bench-test-fixture-"));
    const dupQueries = join(scratchDir, "dup-queries.json");
    writeFileSync(
      dupQueries,
      JSON.stringify({
        queries: [
          { id: "q1", text: "milk", lang: "en", purpose: "semantic" },
          { id: "q1", text: "grocery", lang: "en", purpose: "semantic" },
        ],
      }),
    );
    try {
      await expect(runLanceBenchmark({ corpusPath: CORPUS_PATH, queriesPath: dupQueries })).rejects.toThrow(/duplicate/);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
