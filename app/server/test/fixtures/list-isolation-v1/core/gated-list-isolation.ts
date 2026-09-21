// Owned test child for the #88 pagination-boundary isolation proof. Runs
// INSIDE the real gate, against the full facade bundle (`openEvidenceWriter`),
// exactly like #10's `gated-isolation.ts` -- same real-persistence lane, same
// "this file adds no assertions of its own, it only relays outcomes" contract.
//
// Two things this driver adds beyond #10's, both because the listing methods
// under test do not exist on `origin/main` yet:
//
//   1. `findMethod` searches EVERY facade on the writer object for a method
//      whose name is in the caller's alias list, instead of requiring the
//      caller to name the facade. The eventual `listPeers` etc. may land on
//      any of context/publication/taxonomy/evidence -- this driver does not
//      guess, it looks. A method that genuinely does not exist yet reports
//      `not_implemented`, which the test file treats as "pending", never as
//      a pass.
//   2. A `seed` op writes RAW rows straight through the real `DatasetAdapter`
//      (`makeAdapter` + `openPrivateConnection`, the same two functions the
//      writer service itself is built from) for the two tables --
//      `mcp_calls`, `connections` -- that have no facade writer at all, and
//      is also used for `peers`/`sessions`/`nodes` so every table in this
//      proof is seeded the same way, with full control over row identity and
//      order. This is real persistence through the real adapter, not a
//      mocked store -- it only skips the FACADE's business-rule validation
//      (uniqueness checks etc.), which this proof has no need of.
//
// `walk` and `cross` exist so an entire multi-page pagination proof for one
// method runs inside ONE child process instead of one process PER PAGE
// REQUEST -- a naive "one `call` op per page" design would spawn a Python +
// Bun process per HTTP-shaped request, which at five methods x five page
// sizes x two workspaces x up to twenty pages is hundreds of process spawns
// for what is otherwise a few milliseconds of in-process work.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<
    | { kind: "call"; methodNames: string[]; request: unknown }
    | { kind: "seed"; table: string; rows: Record<string, unknown>[]; epochMsFields?: string[] }
    | { kind: "count"; table: string; predicate: string }
    | {
        kind: "walk";
        methodNames: string[];
        baseRequest: Record<string, unknown>;
        cursorReqKey: string;
        cursorRespKey: string;
        maxPages?: number;
      }
    | {
        kind: "cross";
        methodNames: string[];
        cursorReqKey: string;
        cursorRespKey: string;
        sourceRequest: Record<string, unknown>;
        targetWorkspaceName: string;
      }
  >;
  clockMs?: number;
};

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openEvidenceWriter } = await import(servicePath);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);
const { makeAdapter } = await import(new URL("../../../../src/publication/service.makeAdapter.ts", import.meta.url).pathname);
const { openPrivateConnection } = await import(
  new URL("../../../../src/publication/service.openPrivateConnection.ts", import.meta.url).pathname
);

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; toJSON?: () => { version?: string; message?: string } };
  let version: string | null = null;
  let message: string | null = null;
  try {
    const j = typeof e.toJSON === "function" ? e.toJSON() : undefined;
    version = j?.version ?? null;
    message = j?.message ?? null;
  } catch {
    version = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version, message };
};

let revisionIndex = 0;
const service = await openEvidenceWriter(datasetRoot!, {
  newRevisionId: () => `fallback${String((revisionIndex += 1)).padStart(12, "0")}`,
  clock: () => payload.clockMs ?? 1_758_412_800_000,
  sourceNamespace: null,
});

// A SECOND connection to the SAME dataset, held by the SAME process that
// already owns the writer-gate lock (inherited fd, cooperative file lock --
// not process-scoped). Used only for raw seeding, sequenced strictly BEFORE
// any `call` op runs, never concurrently with the writer service's own reads.
const rawConnection = await openPrivateConnection(datasetRoot!);
const rawAdapter = makeAdapter(rawConnection, () => {});

/** Every facade object on the writer, searched for a method by any of its
 *  known aliases. Returns null -- never throws -- when nothing matches: the
 *  caller decides how to report "not built yet". */
function findMethod(names: string[]): { facade: string; fn: (b: Uint8Array) => Promise<unknown> } | null {
  const svc = service as unknown as Record<string, unknown>;
  for (const facadeKey of Object.keys(svc)) {
    const obj = svc[facadeKey] as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") continue;
    for (const name of names) {
      const candidate = obj[name];
      if (typeof candidate === "function") {
        return { facade: facadeKey, fn: candidate.bind(obj) as (b: Uint8Array) => Promise<unknown> };
      }
    }
  }
  return null;
}

const results: Record<string, unknown> = {};

try {
  for (const [index, op] of payload.ops.entries()) {
    const label = `op${index}`;
    try {
      if (op.kind === "seed") {
        const epochFields = new Set(op.epochMsFields ?? []);
        const rows = op.rows.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) {
            out[key] = epochFields.has(key) && value !== null ? BigInt(value as number) * 1000n : value;
          }
          return out;
        });
        await rawAdapter.append(op.table, rows);
        results[label] = { ok: true, value: { seeded: rows.length } };
      } else if (op.kind === "count") {
        const tbl = await rawConnection.openTable(op.table);
        await tbl.checkoutLatest();
        const rows = await rawRows(tbl, op.predicate);
        results[label] = { ok: true, value: rows.length };
      } else if (op.kind === "walk") {
        const found = findMethod(op.methodNames);
        if (found === null) {
          results[label] = { ok: false, code: "not_implemented", triedNames: op.methodNames, facades: Object.keys(service).sort() };
          continue;
        }
        const pages: unknown[][] = [];
        const totals: unknown[] = [];
        let after: unknown = null;
        let guard = 0;
        const maxPages = op.maxPages ?? 5000;
        let terminated = false;
        while (guard < maxPages) {
          guard += 1;
          const request = { ...op.baseRequest, [op.cursorReqKey]: after };
          const raw = await found.fn(new TextEncoder().encode(JSON.stringify(request)));
          const value = raw as Record<string, unknown>;
          const rows = (value.rows as Record<string, unknown>[] | undefined) ?? [];
          pages.push(rows);
          totals.push(value.total ?? null);
          const next = value[op.cursorRespKey];
          if (next === null || next === undefined) {
            terminated = true;
            break;
          }
          after = next;
        }
        results[label] = { ok: true, facade: found.facade, pages, totals, terminated, pageCount: pages.length };
      } else if (op.kind === "cross") {
        const found = findMethod(op.methodNames);
        if (found === null) {
          results[label] = { ok: false, code: "not_implemented", triedNames: op.methodNames, facades: Object.keys(service).sort() };
          continue;
        }
        const sourceRaw = await found.fn(new TextEncoder().encode(JSON.stringify(op.sourceRequest)));
        const sourceValue = sourceRaw as Record<string, unknown>;
        const sourceCursor = sourceValue[op.cursorRespKey];
        let target: Record<string, unknown>;
        if (sourceCursor === null || sourceCursor === undefined) {
          target = { ok: false, code: "no_source_cursor" };
        } else {
          const targetRequest = { ...op.sourceRequest, workspace_name: op.targetWorkspaceName, [op.cursorReqKey]: sourceCursor };
          try {
            const targetValue = await found.fn(new TextEncoder().encode(JSON.stringify(targetRequest)));
            target = { ok: true, value: targetValue };
          } catch (error) {
            target = { ok: false, ...describeError(error) };
          }
        }
        results[label] = {
          ok: true,
          facade: found.facade,
          sourceRows: (sourceValue.rows as Record<string, unknown>[] | undefined) ?? [],
          sourceCursor,
          target,
        };
      } else {
        const found = findMethod(op.methodNames);
        if (found === null) {
          results[label] = { ok: false, code: "not_implemented", triedNames: op.methodNames, facades: Object.keys(service).sort() };
          continue;
        }
        const value = await found.fn(new TextEncoder().encode(JSON.stringify(op.request)));
        results[label] = { ok: true, facade: found.facade, value };
      }
    } catch (error) {
      results[label] = { ok: false, ...describeError(error) };
    }
  }
} finally {
  results.writerKeys = Object.keys(service).sort();
}

console.log(JSON.stringify(results, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
await service.close();
