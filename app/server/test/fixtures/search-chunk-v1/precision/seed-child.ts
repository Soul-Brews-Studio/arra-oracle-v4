// Owned gated child for the search-chunk-v1 precision fixtures. Runs INSIDE
// the real inherited writer gate.
//
// Shaped after the accepted `fixtures/search-chunk-v1/core/gated-search.ts`:
// same ops-array dispatch over `publication` (to publish a real revision
// `indexRevisionChunks` can resolve) and `context`, and the SAME measured
// `term_ids_raw_shape` reporting in `readRawRows` (the list<utf8?> column
// comes back from the generic Arrow decode as a raw `Vector`, not a plain JS
// array). INDEPENDENT of that file on purpose -- it is owned by the
// ownership/recovery lanes running in parallel tonight.
//
// Extra harness surgery: `insertRawChunk` plants a full 19-column
// `search_chunks_v1` row directly, including states no service call can
// produce -- a `chunk_index`/`attempts` at the Int64 ceiling, a sub-ms
// `last_attempt_at`/`embedded_at`, a `status` outside the closed
// pending/ready/failed set, and an arbitrary `term_ids` list (empty,
// multi-element or containing a null). `embedding` is ALWAYS planted as
// explicit null: this base commit's own writer never populates it either
// (see search-chunk.ts's header), so this harness has no populated-vector
// case to plant that the kernel itself does not already refuse outright.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }>;
  clockMs?: number;
  revisionIds?: string[];
};

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter } = await import(servicePath);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);
const { connect } = await import("@lancedb/lancedb");
const {
  tableFromArrays, vectorFromArray, FixedSizeList, List, Field, Float32, Utf8, makeData, Vector,
} = await import("apache-arrow");
const EMBEDDING_DIMENSION = 384;

/**
 * `term_ids` (`list<utf8?>`) fails apache-arrow's plain-array type
 * INFERENCE (an array of arrays infers a `Struct`, not a `List<Utf8>`) and
 * needs an explicit type passed to `vectorFromArray`.
 */
const TERM_IDS_TYPE = new List(new Field("item", new Utf8(), true));

/**
 * `embedding` (`fixed_size_list<float32?>[384]`) needs the SAME hand-built
 * all-null vector the accepted production writer already measured and uses
 * (`service.ts`'s own `append`, `search_chunks_v1` branch): `vectorFromArray`
 * builds a ZERO-length child float buffer for an all-null column, and
 * LanceDB's native reader then refuses it -- "Values length 0 is less than
 * the length (N) multiplied by the value size (384)" -- because a
 * FixedSizeList's physical layout always reserves the full N*384 slots
 * regardless of which ones the validity bitmap marks null. This harness only
 * ever plants an all-null embedding (this kernel's write path never
 * populates one), so the same construction is reused byte-for-byte.
 */
function allNullEmbeddingVector(rowCount: number) {
  const child = makeData({ type: new Float32(), data: new Float32Array(rowCount * EMBEDDING_DIMENSION) });
  const listData = makeData({
    type: new FixedSizeList(EMBEDDING_DIMENSION, new Field("item", new Float32(), true)),
    length: rowCount,
    nullCount: rowCount,
    nullBitmap: new Uint8Array(Math.ceil(rowCount / 8)), // all-zero: every row null
    child,
  });
  return new Vector([listData]);
}

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

const SEARCH_CHUNK_FIELDS = [
  "id", "workspace_name", "node_id", "revision_id", "chunk_index", "text", "content_hash",
  "chunker_version", "embedding_profile", "embedding", "type_term_id", "term_ids",
  "observer_peer_name", "subject_peer_name", "session_name", "status", "attempts",
  "last_attempt_at", "embedded_at", "error_code",
] as const;

type RawChunkRow = {
  id: string;
  workspace_name: string;
  node_id: string;
  revision_id: string;
  chunk_index: string; // decimal text -> BigInt
  text: string;
  content_hash: string;
  chunker_version: string;
  embedding_profile: string;
  type_term_id: string;
  term_ids: (string | null)[];
  observer_peer_name?: string | null;
  subject_peer_name?: string | null;
  session_name?: string | null;
  status: string;
  attempts: string; // decimal text -> BigInt
  last_attempt_at_micros?: string | null;
  embedded_at_micros?: string | null;
  error_code?: string | null;
};

function chunkColumns(rows: RawChunkRow[]): Record<string, unknown> {
  const columns: Record<string, unknown[]> = Object.fromEntries(
    SEARCH_CHUNK_FIELDS.filter((f) => f !== "embedding" && f !== "term_ids").map((f) => [f, []]),
  );
  const termIds: (string | null)[][] = [];
  for (const row of rows) {
    columns.id!.push(row.id);
    columns.workspace_name!.push(row.workspace_name);
    columns.node_id!.push(row.node_id);
    columns.revision_id!.push(row.revision_id);
    columns.chunk_index!.push(BigInt(row.chunk_index));
    columns.text!.push(row.text);
    columns.content_hash!.push(row.content_hash);
    columns.chunker_version!.push(row.chunker_version);
    columns.embedding_profile!.push(row.embedding_profile);
    columns.type_term_id!.push(row.type_term_id);
    termIds.push(row.term_ids);
    columns.observer_peer_name!.push(row.observer_peer_name ?? null);
    columns.subject_peer_name!.push(row.subject_peer_name ?? null);
    columns.session_name!.push(row.session_name ?? null);
    columns.status!.push(row.status);
    columns.attempts!.push(BigInt(row.attempts));
    columns.last_attempt_at!.push(row.last_attempt_at_micros != null ? BigInt(row.last_attempt_at_micros) : null);
    columns.embedded_at!.push(row.embedded_at_micros != null ? BigInt(row.embedded_at_micros) : null);
    columns.error_code!.push(row.error_code ?? null);
  }
  return {
    ...columns,
    embedding: allNullEmbeddingVector(rows.length),
    term_ids: vectorFromArray(termIds, TERM_IDS_TYPE),
  };
}

const harness: Record<string, (request: any) => Promise<unknown>> = {
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === undefined) {
          out[k] = null;
        } else if (Array.isArray(v)) {
          out[k] = v.map((item) => (item === null ? null : String(item)));
        } else if (k === "embedding") {
          // #90: a populated `embedding` raw-reads as an Arrow Vector too
          // (MEASURED, same shape as `term_ids` below) -- `toArray()` hands
          // back the ACTUAL float32-rounded numbers, kept as JSON numbers
          // (not stringified) so the precision test can compare them exactly
          // against `Math.fround` of the values it wrote.
          out[k] = typeof (v as { toArray?: unknown }).toArray === "function"
            ? Array.from((v as { toArray(): unknown[] }).toArray())
            : String(v);
        } else if (k === "term_ids") {
          out.term_ids_raw_shape = {
            typeofValue: typeof v,
            constructorName: (v as { constructor?: { name?: string } }).constructor?.name ?? null,
            isArray: Array.isArray(v),
            hasToArray: typeof (v as { toArray?: unknown }).toArray === "function",
          };
          out[k] = typeof (v as { toArray?: unknown }).toArray === "function"
            ? (v as { toArray(): unknown[] }).toArray().map((item) => (item === null ? null : String(item)))
            : String(v);
        } else {
          out[k] = String(v);
        }
      }
      return out;
    });
  },
  /** Plant `search_chunks_v1` rows DIRECTLY, bypassing `indexRevisionChunks`
   *  entirely -- the only way to reach an arbitrary `chunk_index`/`attempts`,
   *  a corrupt timestamp, an out-of-set `status`, or an arbitrary `term_ids`
   *  shape. */
  async insertRawChunk(request: { rows: RawChunkRow[] }) {
    const tbl = await harnessTable("search_chunks_v1");
    await tbl.add(tableFromArrays(chunkColumns(request.rows) as never) as never);
    return { inserted: request.rows.length };
  },
  /** ADMISSION PROBE: attempts the same raw insert and reports whether the
   *  ENGINE accepted it. */
  async probeRawChunk(request: { rows: RawChunkRow[] }) {
    const tbl = await harnessTable("search_chunks_v1");
    try {
      await tbl.add(tableFromArrays(chunkColumns(request.rows) as never) as never);
      return { admitted: true, version: await tbl.version() };
    } catch (error) {
      const shaped = error as { name?: string; message?: string };
      return { admitted: false, refusal: { name: shaped.name ?? null, message: String(shaped.message ?? error) } };
    }
  },
};

const trace: string[] = [];
const results: Record<string, unknown> = {};

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; message?: string; toJSON?: () => { version?: string; message?: string } };
  let version: string | null = null;
  let message: string | null = null;
  try {
    const j = typeof e.toJSON === "function" ? e.toJSON() : undefined;
    version = j?.version ?? null;
    message = j?.message ?? e.message ?? null;
  } catch {
    version = null;
    message = e?.message ?? null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version, message };
};

let revisionIndex = 0;
const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(12, "0")}`,
  clock: () => payload.clockMs ?? 1_758_412_800_000,
  sourceNamespace: null,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
  },
});

try {
  for (const [index, op] of payload.ops.entries()) {
    const label = `op${index}`;
    if (op.facade === "harness") {
      try {
        results[label] = { ok: true, value: await harness[op.method]!(op.request) };
      } catch (error) {
        results[label] = { ok: false, ...describeError(error) };
      }
      continue;
    }
    const facade = (service as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[
      op.facade ?? "context"
    ];
    const call = facade?.[op.method];
    if (typeof call !== "function") {
      results[label] = { ok: false, code: "no_such_method" };
      continue;
    }
    try {
      results[label] = { ok: true, value: await call(new TextEncoder().encode(JSON.stringify(op.request))) };
    } catch (error) {
      results[label] = { ok: false, ...describeError(error) };
    }
  }
} finally {
  results.trace = trace;
}

console.log(JSON.stringify(results));
await service.close();
