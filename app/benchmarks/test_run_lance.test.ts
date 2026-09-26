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

    const icu = manifest.tokenizers as Record<string, Record<string, unknown>>;
    // Measured (LANCEDB-FACTS.md / analysis-7): icu's un-requested options
    // default to English stemming and stop-word removal ON.
    expect(icu.icu).toMatchObject({ base_tokenizer: "icu", language: "English", stem: true, remove_stop_words: true });
    // ngram3 explicitly disables both, per R14.
    expect(icu.ngram3).toMatchObject({ base_tokenizer: "ngram", min_ngram_length: 3, max_ngram_length: 3, stem: false, remove_stop_words: false });
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
      expect(manifest.embedding).toMatchObject({ status: "not_run", model: null, ollama_digest: null, dims: null });
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
    expect(ranking(runs.methods.vector, "q_lum")).toEqual(expect.arrayContaining(["r1", "r2", "r3"]));
    expect(manifest.embedding).toMatchObject({ status: "frozen", model: "stub-test-model", dims: 3, distance: "l2" });
    expect(fetchCalls).toHaveLength(0);
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
});
