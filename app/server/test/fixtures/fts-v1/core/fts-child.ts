// Owned test child for the legacy `memories` keyword path (#10, R14).
//
// Why a child process at all: `src/storage.ts` captures ARRA_DATA_DIR at
// import, and `src/db.ts` keeps one module-level table handle. Bun runs every
// test file of a suite in ONE process with ONE module cache, so a second test
// file importing `src/db` would silently reuse the first file's dataset (and
// see it deleted by that file's cleanup). A child gets its own module cache
// and its own ARRA_DATA_DIR, so this lane drives the REAL product path --
// `db.ts`, the startup index work, the HTTP route and the MCP tool -- without
// touching `mcp-correctness.test.ts`'s singleton.
//
// Like the gated children, this file makes no assertions: it relays each op's
// value (or its error message) to the parent as one JSON line.
//
// Usage: bun fts-child.ts '<json {ops:[...]}>'   with ARRA_DATA_DIR and
// ARRA_AUTH_POLICY set by the parent to a fresh mktemp dataset.
import { readArgPayload } from "../../../helpers/argv.readArgPayload";
const [, , payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as { ops: Array<Record<string, any>> };

const src = (path: string) => new URL(`../../../../src/${path}`, import.meta.url).pathname;
const store = await import(src("db.ts"));
const { runStartupIndexWork } = await import(src("composition.ts"));
const { connect, Index } = await import("@lancedb/lancedb");

const ORIGIN = "http://127.0.0.1:3939";
let app: { handle(request: Request): Promise<Response> } | null = null;
const theApp = async () => {
  if (app === null) {
    const { buildApp } = await import(src("index.ts"));
    app = await buildApp({ policyPath: process.env.ARRA_AUTH_POLICY!, origin: ORIGIN });
  }
  return app!;
};
const headers = (token: string, extra: Record<string, string> = {}) => ({
  host: "127.0.0.1:3939",
  authorization: `Bearer ${token}`,
  ...extra,
});

/** The raw table, opened on a connection of its own -- the deployment's view. */
const rawTable = async () => {
  const tbl = await (await connect(process.env.ARRA_DATA_DIR!)).openTable("memories");
  await tbl.checkoutLatest();
  return tbl;
};
const FTS_DETAIL_KEYS = ["base_tokenizer", "min_ngram_length", "max_ngram_length", "prefix_only", "stem", "remove_stop_words"];

const ops: Record<string, (op: Record<string, any>) => Promise<unknown>> = {
  insert: (op) => store.insert({ name: op.name ?? "fts-row", workspace_name: op.workspace_name, content: op.content }),
  ensureFtsIndex: (op) => store.ensureFtsIndex(op.replace),
  startupIndexWork: async () => {
    await runStartupIndexWork();
    return null;
  },
  searchText: (op) => store.searchText(op.q, op.bank, op.limit),
  version: async () => (await store.db()).version(),
  // Every FTS index on `memories.content`, with only the fields R14 governs.
  ftsIndices: async () =>
    (await (await rawTable()).listIndices())
      .filter((i) => ["FTS", "INVERTED"].includes(i.indexType.toUpperCase()) && i.columns.includes("content"))
      .map((i) => ({
        name: i.name,
        details: Object.fromEntries(FTS_DETAIL_KEYS.map((k) => [k, (i.indexDetails ?? {})[k]])),
      })),
  // Plant an index the way an older deployment would have left it.
  rawFtsIndex: async (op) => {
    await (await rawTable()).createIndex("content", {
      config: Index.fts(op.options),
      replace: true,
      ...(op.name === undefined ? {} : { name: op.name }),
    });
    return null;
  },
  http: async (op) => {
    const response = await (await theApp()).handle(new Request(`${ORIGIN}${op.path}`, { headers: headers(op.token) }));
    return { status: response.status, body: await response.json() };
  },
  mcp: async (op) => {
    const response = await (await theApp()).handle(
      new Request(`${ORIGIN}/mcp/${encodeURIComponent(op.bank)}`, {
        method: "POST",
        headers: headers(op.token, { "content-type": "application/json" }),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: op.tool, arguments: op.args } }),
      }),
    );
    const wire = (await response.json()) as any;
    const text = wire.result?.content?.[0]?.text;
    let value: unknown = text ?? null;
    try {
      value = typeof text === "string" ? JSON.parse(text) : value;
    } catch {
      // A tool error is plain text, not JSON: relay it as the string it is.
    }
    return { status: response.status, isError: wire.result?.isError === true, value };
  },
};

const out: Record<string, unknown> = {};
for (const [index, op] of payload.ops.entries()) {
  try {
    const run = ops[op.op];
    if (run === undefined) throw new Error(`unknown op ${op.op}`);
    out[`op${index}`] = { ok: true, value: await run(op) };
  } catch (error) {
    out[`op${index}`] = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
console.log(JSON.stringify(out, (_key, value) => (typeof value === "bigint" ? value.toString(10) : value)));
