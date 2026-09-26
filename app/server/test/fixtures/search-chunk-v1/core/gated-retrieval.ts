// Owned test child for #30 retrieval (overnight R7 #30 part + R14). Runs INSIDE
// the real writer gate.
//
// It opens the evidence WRITER -- the only facade allowed to build the chunk
// text index -- and, in the same process, a gateless READER carrying an
// injected stub query embedder. That is the transport's own split: every
// search runs on the reader, every write on the writer. Nothing here calls a
// model or the network; a query the payload gave no vector for makes the stub
// throw, which is how the "embedder unavailable" case is reached.
//
// Ops dispatch by facade:
//   publication/context  -> the writer bundle (bytes in, value out)
//   reader               -> the reader bundle's context facade
//   harness              -> test-side dataset inspection/surgery on
//                           search_chunks_v1's indexes (never product code)
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ label: string; facade: "publication" | "context" | "reader" | "harness"; method: string; request?: any }>;
  revisionIds: string[];
  clockMs?: number;
  embedderProfile: string;
  queryVectors: Record<string, number[]>;
};

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openEvidenceReader, openEvidenceWriter } = await import(servicePath);
const { connect, Index } = await import("@lancedb/lancedb");

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
  embedder,
});
const reader = await openEvidenceReader(datasetRoot!, { embedder });

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
      const bundle = op.facade === "reader" ? reader.context : (writer as Record<string, any>)[op.facade];
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
}

console.log(JSON.stringify(results));
await writer.close();
