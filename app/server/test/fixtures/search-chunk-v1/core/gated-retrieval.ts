// Owned test child for #30 retrieval (overnight R7 #30 part + R14). Runs INSIDE
// the real writer gate.
//
// It opens the evidence WRITER -- the only facade allowed to build the chunk
// text index -- and, in the same process, a gateless READER carrying an
// injected stub query embedder. That is the transport's own split: every
// search runs on the reader, every write on the writer. The writer is opened
// with NO embedder and carries no search method at all (the searches are
// reader-only, like #32 / R9's chat); `writerContextMethods` reports that. Nothing here calls a
// model or the network; a query the payload gave no vector for makes the stub
// throw, which is how the "embedder unavailable" case is reached.
//
// Ops dispatch by facade:
//   publication/context  -> the writer bundle (bytes in, value out)
//   reader               -> the reader bundle's context facade
//   reader_other         -> a second reader whose query embedder serves
//                           `otherProfile` (the profile-default and
//                           profile-filter cases)
//   harness              -> test-side dataset inspection/surgery on
//                           search_chunks_v1's rows and indexes (never
//                           product code)
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ label: string; facade: "publication" | "context" | "reader" | "reader_other" | "harness"; method: string; request?: any }>;
  revisionIds: string[];
  clockMs?: number;
  embedderProfile: string;
  otherProfile?: string;
  queryVectors: Record<string, number[]>;
};

const src = (file: string) => new URL(`../../../../src/${file}`, import.meta.url).pathname;
const { openEvidenceReader, openEvidenceWriter } = await import(src("publication/service.ts"));
const { makeAdapter } = await import(src("publication/service.makeAdapter.ts"));
const { openPrivateConnection } = await import(src("publication/service.openPrivateConnection.ts"));
const { searchKnowledgeKeyword } = await import(src("publication/service.searchKnowledgeKeyword.ts"));
const { connect, Index } = await import("@lancedb/lancedb");
const { chmodSync, mkdirSync } = await import("node:fs");
const { join } = await import("node:path");

const embedCalls: string[] = [];
const embedder = {
  profile: payload.embedderProfile,
  embed: async (text: string): Promise<number[]> => {
    embedCalls.push(text);
    const vector = payload.queryVectors[text];
    if (vector === undefined) throw new Error("stub embedder: no vector for this query");
    return vector;
  },
};

let revisionIndex = 0;
const writer = await openEvidenceWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(13, "0")}`,
  clock: () => payload.clockMs ?? 1_758_412_800_000,
  sourceNamespace: null,
});
const reader = await openEvidenceReader(datasetRoot!, { embedder });
const readerOther = await openEvidenceReader(datasetRoot!, {
  embedder: { profile: payload.otherProfile ?? "other-profile", embed: embedder.embed },
});
/** The index files of search_chunks_v1, for the build-failure surgery. */
const indexDir = join(datasetRoot!, "search_chunks_v1.lance", "_indices");

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const chunkTable = async () => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable("search_chunks_v1");
  await tbl.checkoutLatest();
  return tbl;
};

const harness: Record<string, (request: any) => Promise<unknown>> = {
  async listIndices() {
    const tbl = await chunkTable();
    return (await tbl.listIndices()).map((index) => ({
      name: index.name,
      indexType: index.indexType,
      columns: index.columns,
      indexUuid: (index as { indexUuid?: string }).indexUuid ?? null,
      base_tokenizer: (index.indexDetails as Record<string, unknown> | undefined)?.base_tokenizer ?? null,
      min_ngram_length: (index.indexDetails as Record<string, unknown> | undefined)?.min_ngram_length ?? null,
      max_ngram_length: (index.indexDetails as Record<string, unknown> | undefined)?.max_ngram_length ?? null,
      stem: (index.indexDetails as Record<string, unknown> | undefined)?.stem ?? null,
      remove_stop_words: (index.indexDetails as Record<string, unknown> | undefined)?.remove_stop_words ?? null,
    }));
  },
  /** Surgery: remove every index on search_chunks_v1 (a dataset from before
   *  this slice, or one whose index build failed). */
  async dropIndices() {
    const tbl = await chunkTable();
    for (const index of await tbl.listIndices()) await tbl.dropIndex(index.name);
    return (await tbl.listIndices()).length;
  },
  /** Surgery: an older deployment's word-segmenting `icu` index on the text. */
  async createIcuIndex() {
    const tbl = await chunkTable();
    await tbl.createIndex("text", { config: Index.fts({ baseTokenizer: "icu" }), replace: true });
    return (await tbl.listIndices()).map((index) => index.name);
  },
  async embedCalls() {
    return [...embedCalls];
  },
  /** Surgery: a chunk that keeps its stored vector but is NOT `ready` -- what
   *  an embed step that stores a vector and then marks the chunk failed would
   *  leave. No product writer does this today; semantic search must still
   *  refuse it. Answers the row's status and whether its vector is there. */
  async markChunkFailed(request: { id: string }) {
    const tbl = await chunkTable();
    const where = `id = '${request.id.replaceAll("'", "''")}'`;
    await tbl.update({ where, values: { status: "failed" } });
    const rows = await tbl.query().where(where).select(["status", "embedding"]).toArray();
    return rows.map((row) => ({ status: row.status, has_vector: row.embedding !== null && row.embedding !== undefined }));
  },
  /** Surgery: move one chunk row onto ANOTHER embedding profile -- its
   *  `embedding_profile` and the `id` derived from it -- as a row written
   *  under a since-retired profile id would sit (#30 R7: one table holds
   *  several profiles, as built). The closed registry refuses every
   *  `indexRevisionChunks` request under a non-active name, so a second
   *  profile's row can only be planted this way, never by product code.
   *  Answers the moved row's id and profile. */
  async relabelChunkProfile(request: { id: string; newId: string; profile: string }) {
    const tbl = await chunkTable();
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await tbl.update({ where: `id = ${quote(request.id)}`, values: { id: request.newId, embedding_profile: request.profile } });
    const rows = await tbl.query().where(`id = ${quote(request.newId)}`).select(["id", "embedding_profile"]).toArray();
    return rows.map((row) => ({ id: row.id, embedding_profile: row.embedding_profile }));
  },
  /** Surgery: make the NEXT index build fail for real (the index directory is
   *  not writable), while row appends -- data/, _versions/ -- still land. */
  async lockIndexDir() {
    mkdirSync(indexDir, { recursive: true });
    chmodSync(indexDir, 0o555);
    return true;
  },
  async unlockIndexDir() {
    chmodSync(indexDir, 0o755);
    return true;
  },
  /** How many chunk rows the text index covers, and how many it does not. */
  async indexStats() {
    const tbl = await chunkTable();
    const [index] = (await tbl.listIndices()).filter((i) => i.columns.includes("text"));
    if (index === undefined) return null;
    const stats = await tbl.indexStats(index.name);
    return { indexed: stats?.numIndexedRows ?? null, unindexed: stats?.numUnindexedRows ?? null };
  },
  /** Run searchKnowledgeKeyword over a spying adapter and report every
   *  CANDIDATE chunk's node id -- what the candidate query itself returned,
   *  before any head/eligibility/workspace re-check. */
  async spyKeyword(request) {
    const base = makeAdapter(await openPrivateConnection(datasetRoot!), () => {});
    const candidates: string[] = [];
    const record = (rows: Record<string, unknown>[]) => {
      for (const row of rows) candidates.push(row.node_id as string);
      return rows;
    };
    const spy = {
      ...base,
      fullTextSearchChunks: async (...args: unknown[]) => record(await base.fullTextSearchChunks(...args)),
      orderedProjection: async (table: string, ...rest: unknown[]) => {
        const rows = await base.orderedProjection(table, ...rest);
        return table === "search_chunks_v1" ? record(rows) : rows;
      },
    };
    const value = await searchKnowledgeKeyword(spy, new TextEncoder().encode(JSON.stringify(request)));
    return { value, candidates: [...new Set(candidates)].sort() };
  },
};

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; message?: string; toJSON?: () => { version?: string } };
  let version: string | null = null;
  try {
    version = typeof e.toJSON === "function" ? e.toJSON()?.version ?? null : null;
  } catch {
    version = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version, message: e.message ?? null };
};

const results: Record<string, unknown> = {};
try {
  for (const op of payload.ops) {
    try {
      if (op.facade === "harness") {
        results[op.label] = { ok: true, value: await harness[op.method]!(op.request) };
        continue;
      }
      const bundle =
        op.facade === "reader" ? reader.context : op.facade === "reader_other" ? readerOther.context : (writer as Record<string, any>)[op.facade];
      const call = bundle?.[op.method];
      if (typeof call !== "function") {
        results[op.label] = { ok: false, code: "no_such_method" };
        continue;
      }
      const started = performance.now();
      const value = await call(new TextEncoder().encode(JSON.stringify(op.request)));
      results[op.label] = { ok: true, value, ms: Math.round(performance.now() - started) };
    } catch (error) {
      results[op.label] = { ok: false, ...describeError(error) };
    }
  }
} finally {
  results.readerContextMethods = Object.keys(reader.context).sort();
  results.writerContextMethods = Object.keys(writer.context).sort();
}

console.log(JSON.stringify(results));
await writer.close();
