// app/benchmarks/run_lance.ts -- Bun executor for #7 (R16/A3).
//
// Drives REAL LanceDB retrieval -- not a simulation -- over a frozen corpus
// and query set, and writes `runs.json` + `manifest.json` for
// `harness_runner.py` (Python) to score. This file runs no scoring itself:
// MRR/recall/RRF stay in `harness_metrics.py` (frozen for #52) and
// `harness_runner.py` (R16/A1).
//
// Why TypeScript, not the Python `lancedb` package: TS owns search in this
// codebase (AGENTS.md), and the Python venv pins a DIFFERENT LanceDB
// version (0.39.0 vs the product's 0.38.0 -- see LANCEDB-FACTS.md /
// analysis-7). Measuring the product profile means using the product's own
// SDK, so this imports `@lancedb/lancedb` 0.38.0 straight out of
// `app/server/node_modules` by relative path -- `app/benchmarks` has no
// `package.json`/`node_modules` of its own, and this is the deliberate way
// to reuse the sibling app's pinned install rather than adding a dependency.
//
// Four profiles, one candidate pool, one eligibility filter, so the numbers
// are actually comparable:
//   - `icu`      -- exactly the product's current FTS config (mirrors
//                   app/server/src/db.ts:112). Duplicated here rather than
//                   imported because db.ts exports nothing today; see the
//                   TODO on ICU_LEGACY_PRODUCT_FTS_OPTIONS.
//   - `ngram3`   -- SPEC/R14's ngram(3,3), no stem, no stop words. See the
//                   TODO on NGRAM3_FTS_INDEX_OPTIONS.
//   - `literal_includes` -- exact case-folded substring scan, labelled
//                   `literal`, never `trigram`: LanceDB's ngram profile is
//                   still tokenized BM25, not a literal substring engine
//                   (measured in LANCEDB-FACTS.md).
//   - `vector`   -- LanceDB `vectorSearch` over PRECOMPUTED, FROZEN query
//                   and corpus vectors read from a file. This module makes
//                   NO model call and imports no embedder: with no vectors
//                   file, the profile reports `not_run` with a reason,
//                   never a silent zero. Tests always stub the vectors file.
//                   The vectors file's OWN `distance` is passed to
//                   `.distanceType()` (never left to LanceDB's L2 default)
//                   and every corpus/query vector length is checked against
//                   the file's declared `dims` before any search runs --
//                   otherwise the manifest could echo a distance/dims that
//                   the search never actually used (found by adversarial
//                   review: relabelling `dims` in a copy of a fixture, with
//                   the real vectors left unchanged, passed silently).
//
// Every corpus/query/qrels/vectors file this run consumed is sha256-hashed
// into the manifest, and every FTS profile's ACTUAL index configuration is
// read back from `table.listIndices()[].indexDetails` -- not the options
// object this file requested, because LanceDB fills in defaults the
// request left unset (measured: `stem`/`removeStopWords`/`asciiFolding`
// default `true` even for the `ngram3` profile's un-requested fields).
//
// Real memory content never reaches this file: `corpus.json` for a Phase B
// run is Nat's local, uncommitted artifact (see README.md's Phase B
// section); this executor only ever reads paths it is given.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, Index, type Connection, type Table } from "../server/node_modules/@lancedb/lancedb";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_NODE_MODULES = join(HERE, "..", "server", "node_modules");

/** Fixed workspace value: this executor always builds a single-workspace
 * table, but every query still runs through the SAME `.where()` scope a
 * real multi-tenant read would use, so the eligibility filter recorded in
 * the manifest is not fiction. */
export const WORKSPACE_NAME = "bench";

/** Mirrors `app/server/src/publication/service.indexRevisionChunks.ts:62`
 * exactly: title and body joined with a blank line. */
export const INDEXED_TEXT_COMPOSITION = "${title}\n\n${body}";

export function composeIndexedText(title: string, body: string): string {
  return `${title}\n\n${body}`;
}

/**
 * Mirrors `app/server/src/db.ts:112` exactly -- the product's CURRENT FTS
 * config (`Index.fts({ baseTokenizer: "icu" })`, every other option left at
 * its LanceDB default).
 *
 * TODO(#30): once `db.ts` exports this as a shared constant, import it
 * here instead of duplicating it, so the `icu` profile measured here
 * cannot silently drift from the product index it previews.
 */
export const ICU_LEGACY_PRODUCT_FTS_OPTIONS = { baseTokenizer: "icu" as const };

/**
 * Per ruling R14 (`docs/overnight/DECISIONS.md`): ngram(3,3), no stemming,
 * no stop-word removal. No shared `FTS_INDEX_OPTIONS` module exists on this
 * base (`rg FTS_INDEX_OPTIONS app/server/src` finds nothing as of this
 * slice) -- this is the value R14 specifies, defined identically here.
 *
 * TODO(fts-ngram slice): once a shared module exports `FTS_INDEX_OPTIONS`,
 * import it here instead of this local copy.
 */
export const NGRAM3_FTS_INDEX_OPTIONS = {
  baseTokenizer: "ngram" as const,
  ngramMinLength: 3,
  ngramMaxLength: 3,
  prefixOnly: false,
  stem: false,
  removeStopWords: false,
};

export const RRF_K = 60;
export const RRF_TIE_RULE = "utf16_code_unit"; // matches harness_metrics.py's _utf16_order

export interface CorpusDocument {
  id: string;
  title: string;
  type: string;
  body: string;
  lang: string;
}

export interface CorpusFile {
  documents: CorpusDocument[];
}

export interface QueryRow {
  id: string;
  text: string;
  lang?: string;
  purpose?: string;
}

export interface QueriesFile {
  queries: QueryRow[];
}

export interface VectorsFile {
  model: string;
  dims: number;
  distance: string;
  normalization: string;
  ollama_digest: string;
  request_options?: Record<string, unknown> | null;
  corpus: Record<string, number[]>;
  queries: Record<string, number[]>;
}

/** The only distance metrics LanceDB's `VectorQuery.distanceType()` accepts
 * (`app/server/node_modules/@lancedb/lancedb/dist/indices.d.ts`). A vectors
 * file naming anything else is refused rather than silently searched with
 * LanceDB's L2 default while the manifest echoes the requested-but-unused
 * value -- exactly the gap an adversarial review found here (manifest said
 * `distance:"cosine"`, the search ran L2 because nothing ever called
 * `.distanceType()`). */
export const SUPPORTED_DISTANCES = ["l2", "cosine", "dot"] as const;
export type SupportedDistance = (typeof SUPPORTED_DISTANCES)[number];

function isSupportedDistance(value: string): value is SupportedDistance {
  return (SUPPORTED_DISTANCES as readonly string[]).includes(value);
}

/**
 * Refuses two ways the manifest's `embedding.dims`/`embedding.distance` can
 * lie about what the search actually did: an unsupported/unused distance
 * name, and a corpus vector whose real length doesn't match the declared
 * `dims` (the file's OWN internal contradiction -- reproduced by an
 * adversarial review that left the vectors unchanged but relabelled
 * `dims: 999`). Query vectors are checked per query in `runLanceBenchmark`
 * instead of here, so one bad query vector errors only that query.
 */
function validateFrozenVectors(vectors: VectorsFile, documents: CorpusDocument[]): SupportedDistance {
  if (!isSupportedDistance(vectors.distance)) {
    throw new Error(`run_lance: vectors.distance must be one of ${SUPPORTED_DISTANCES.join(", ")}, got ${JSON.stringify(vectors.distance)}`);
  }
  for (const doc of documents) {
    const vector = vectors.corpus[doc.id];
    if (vector && vector.length !== vectors.dims) {
      throw new Error(`run_lance: vectors.corpus[${doc.id}] has length ${vector.length}, but vectors.dims says ${vectors.dims}`);
    }
  }
  return vectors.distance;
}

/** One method's report for one query: a ranking (complete) or an error. */
export type QueryOutcome = string[] | { status: "error"; code: string };

/** One method's report across every query, OR a whole-method not_run
 * marker -- the exact two shapes `harness_runner.run_benchmark` accepts. */
export type MethodRun = Record<string, QueryOutcome> | { status: "not_run"; reason: string };

export interface RunLanceOptions {
  corpusPath: string;
  queriesPath: string;
  qrelsPath?: string;
  vectorsPath?: string;
  outRunsPath?: string;
  outManifestPath?: string;
}

export interface RunLanceResult {
  runs: { methods: Record<string, MethodRun> };
  manifest: Record<string, unknown>;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256OfFile(path: string | undefined): string | null {
  if (!path) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readEngineVersions(): Record<string, string> {
  const lancedbPkg = readJsonFile<{ version: string }>(join(SERVER_NODE_MODULES, "@lancedb/lancedb/package.json"));
  const arrowPkg = readJsonFile<{ version: string }>(join(SERVER_NODE_MODULES, "apache-arrow/package.json"));
  return { "@lancedb/lancedb": lancedbPkg.version, "apache-arrow": arrowPkg.version };
}

function requireNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`run_lance: ${where} must be a non-empty string`);
  return value;
}

function validateCorpus(raw: unknown): CorpusFile {
  const doc = raw as Partial<CorpusFile> | null;
  if (!doc || !Array.isArray(doc.documents) || doc.documents.length === 0) {
    throw new Error("run_lance: corpus.documents must be a non-empty array");
  }
  const documents = doc.documents.map((entry, index) => {
    const d = entry as Partial<CorpusDocument>;
    return {
      id: requireNonEmptyString(d.id, `corpus.documents[${index}].id`),
      title: requireNonEmptyString(d.title, `corpus.documents[${index}].title`),
      type: requireNonEmptyString(d.type, `corpus.documents[${index}].type`),
      body: requireNonEmptyString(d.body, `corpus.documents[${index}].body`),
      lang: requireNonEmptyString(d.lang, `corpus.documents[${index}].lang`),
    };
  });
  const ids = new Set(documents.map((d) => d.id));
  if (ids.size !== documents.length) throw new Error("run_lance: corpus.documents[].id must not contain duplicates");
  return { documents };
}

function validateQueries(raw: unknown): QueriesFile {
  const doc = raw as Partial<QueriesFile> | null;
  if (!doc || !Array.isArray(doc.queries) || doc.queries.length === 0) {
    throw new Error("run_lance: queries.queries must be a non-empty array");
  }
  const queries = doc.queries.map((entry, index) => {
    const q = entry as Partial<QueryRow>;
    return {
      id: requireNonEmptyString(q.id, `queries.queries[${index}].id`),
      text: requireNonEmptyString(q.text, `queries.queries[${index}].text`),
      lang: q.lang,
      purpose: q.purpose,
    };
  });
  const ids = new Set(queries.map((q) => q.id));
  if (ids.size !== queries.length) throw new Error("run_lance: queries.queries[].id must not contain duplicates");
  return { queries };
}

async function buildTable(conn: Connection, documents: CorpusDocument[], vectors: VectorsFile | undefined): Promise<Table> {
  const rows = documents.map((doc) => {
    const text = composeIndexedText(doc.title, doc.body);
    const row: Record<string, unknown> = {
      id: doc.id,
      workspace_name: WORKSPACE_NAME,
      title: doc.title,
      type: doc.type,
      body: doc.body,
      lang: doc.lang,
      text_icu: text,
      text_ngram3: text,
    };
    if (vectors) {
      const vector = vectors.corpus[doc.id];
      if (!vector) throw new Error(`run_lance: vectors file has no corpus entry for document id ${doc.id}`);
      row.embedding = Float32Array.from(vector);
    }
    return row;
  });
  return conn.createTable("bench_chunks", rows);
}

async function readIndexDetails(table: Table, column: string): Promise<unknown> {
  const indices = await table.listIndices();
  const found = indices.find((index) => index.columns.includes(column));
  if (!found) throw new Error(`run_lance: no index found on column ${column} after createIndex`);
  return found.indexDetails ?? null;
}

function literalIncludesSearch(rows: { id: string; text: string }[], query: string, limit: number): string[] {
  const needle = query.toLowerCase();
  return rows
    .filter((row) => row.text.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((row) => row.id);
}

async function ftsSearchIds(table: Table, column: string, query: string, limit: number): Promise<string[]> {
  const rows = await table
    .search(query, "fts", column)
    .where(`workspace_name = '${WORKSPACE_NAME}'`)
    .limit(limit)
    .toArray();
  return rows.map((row: Record<string, unknown>) => row.id as string);
}

async function vectorSearchIds(table: Table, vector: number[], limit: number, distance: SupportedDistance): Promise<string[]> {
  const rows = await table
    .vectorSearch(vector)
    .distanceType(distance)
    .where(`workspace_name = '${WORKSPACE_NAME}'`)
    .limit(limit)
    .toArray();
  return rows.map((row: Record<string, unknown>) => row.id as string);
}

/** Runs `fn` for every query, catching a per-query failure into an `error`
 * outcome INSTEAD of aborting the whole method -- one query's crash is not
 * license to silently drop every other query's real answer. */
async function perQuery(queries: QueryRow[], fn: (query: QueryRow) => Promise<string[]>): Promise<Record<string, QueryOutcome>> {
  const out: Record<string, QueryOutcome> = {};
  for (const query of queries) {
    try {
      out[query.id] = await fn(query);
    } catch (error) {
      out[query.id] = { status: "error", code: error instanceof Error ? error.message : String(error) };
    }
  }
  return out;
}

/**
 * Run every profile over a fresh, temporary LanceDB and return the runs +
 * manifest that `harness_runner.run_benchmark` expects (`manifest` is
 * REQUIRED there; every key here is always present, per R16/A1).
 *
 * Makes NO network or model call: the `vector` profile only ever reads
 * `options.vectorsPath`. With no vectors file, `vector` is reported
 * `not_run` with a reason, and the manifest's `embedding.status` is
 * `"not_run"` -- never a silent skip and never an invented zero.
 */
export async function runLanceBenchmark(options: RunLanceOptions): Promise<RunLanceResult> {
  const corpus = validateCorpus(readJsonFile(options.corpusPath));
  const queries = validateQueries(readJsonFile(options.queriesPath));
  const vectors = options.vectorsPath ? readJsonFile<VectorsFile>(options.vectorsPath) : undefined;

  const candidateLimit = corpus.documents.length;
  const eligibilityFilter = `workspace_name = '${WORKSPACE_NAME}'`;

  const dbDir = mkdtempSync(join(tmpdir(), "arra-bench-lance-"));
  let conn: Connection | undefined;
  try {
    conn = await connect(dbDir);
    const table = await buildTable(conn, corpus.documents, vectors);

    await table.createIndex("text_icu", { config: Index.fts(ICU_LEGACY_PRODUCT_FTS_OPTIONS) });
    await table.createIndex("text_ngram3", { config: Index.fts(NGRAM3_FTS_INDEX_OPTIONS) });

    const tokenizers = {
      icu: await readIndexDetails(table, "text_icu"),
      ngram3: await readIndexDetails(table, "text_ngram3"),
    };

    const literalRows = corpus.documents.map((doc) => ({ id: doc.id, text: composeIndexedText(doc.title, doc.body) }));

    const methods: Record<string, MethodRun> = {
      icu: await perQuery(queries.queries, (q) => ftsSearchIds(table, "text_icu", q.text, candidateLimit)),
      ngram3: await perQuery(queries.queries, (q) => ftsSearchIds(table, "text_ngram3", q.text, candidateLimit)),
      literal_includes: await perQuery(queries.queries, async (q) => literalIncludesSearch(literalRows, q.text, candidateLimit)),
    };

    let embeddingManifest: Record<string, unknown>;
    if (vectors) {
      // Refuses BEFORE any search runs: an unsupported distance name, or a
      // corpus vector whose real length contradicts the declared `dims`.
      // Both would otherwise let `embeddingManifest` below assert something
      // the search never actually did.
      const distance = validateFrozenVectors(vectors, corpus.documents);
      methods.vector = await perQuery(queries.queries, (q) => {
        const queryVector = vectors.queries[q.id];
        if (!queryVector) throw new Error(`run_lance: vectors file has no query entry for query id ${q.id}`);
        if (queryVector.length !== vectors.dims) {
          throw new Error(`run_lance: query ${q.id}'s vector has length ${queryVector.length}, but vectors.dims says ${vectors.dims}`);
        }
        return vectorSearchIds(table, queryVector, candidateLimit, distance);
      });
      embeddingManifest = {
        status: "frozen",
        model: vectors.model,
        ollama_digest: vectors.ollama_digest,
        dims: vectors.dims,
        distance,
        normalization: vectors.normalization,
        request_options: vectors.request_options ?? null,
      };
    } else {
      methods.vector = {
        status: "not_run",
        reason: "no frozen vectors supplied -- see README.md Phase B (freeze_vectors is operator-invoked; tests stub vectors, no Ollama call)",
      };
      embeddingManifest = {
        status: "not_run",
        model: null,
        ollama_digest: null,
        dims: null,
        distance: null,
        normalization: null,
        request_options: null,
      };
    }

    const manifest = {
      engine: readEngineVersions(),
      tokenizers,
      indexed_text_composition: INDEXED_TEXT_COMPOSITION,
      candidate_limit: candidateLimit,
      eligibility_filter: eligibilityFilter,
      embedding: embeddingManifest,
      artifact_sha256: {
        corpus: sha256OfFile(options.corpusPath),
        queries: sha256OfFile(options.queriesPath),
        qrels: sha256OfFile(options.qrelsPath),
        vectors: sha256OfFile(options.vectorsPath),
      },
      rrf: { k: RRF_K, tie_rule: RRF_TIE_RULE },
    };

    const runs = { methods };

    if (options.outRunsPath) writeFileSync(options.outRunsPath, `${JSON.stringify(runs, null, 2)}\n`);
    if (options.outManifestPath) writeFileSync(options.outManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return { runs, manifest };
  } finally {
    conn?.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): RunLanceOptions {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`run_lance: --${key} requires a value`);
      flags[key] = value;
      i += 1;
    }
  }
  if (!flags.corpus || !flags.queries) {
    throw new Error("run_lance: usage: bun run run_lance.ts --corpus corpus.json --queries queries.json [--qrels qrels.json] [--vectors vectors.json] --out-runs runs.json --out-manifest manifest.json");
  }
  return {
    corpusPath: flags.corpus,
    queriesPath: flags.queries,
    qrelsPath: flags.qrels,
    vectorsPath: flags.vectors,
    outRunsPath: flags["out-runs"],
    outManifestPath: flags["out-manifest"],
  };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  await runLanceBenchmark(options);
}
