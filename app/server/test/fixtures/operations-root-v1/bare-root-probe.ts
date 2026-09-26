// Standalone probe (NOT a `bun:test` file, never discovered by any glob):
// prints one JSON line describing what `listMcpCalls`/`listConnections`
// answer against an `ARRA_DATA_DIR` that has NEITHER table.
// `calls.openCallLogTable.ts` and `connections.openConnectionsTable.ts` cache
// their LanceDB connection at module scope
// (`storage.ts`'s `DATA_DIR` is fixed at import), so this MUST run in its own
// fresh process -- reusing any process that already opened a table for this
// root, or any other root, would answer from the wrong cached state. The
// caller (`../../operations-root-readers.test.ts`) spawns this file directly
// via `Bun.spawn([process.execPath, thisPath], { env: { ARRA_DATA_DIR: ... } })`.
//
// #102/#103 fix-round nonblocking finding: before this file's callers existed
// (`calls.listMcpCalls.ts` / `connections.listConnections.ts` catching the
// "table not found" error), a missing table answered with the raw LanceDB SDK
// message -- including the absolute dataset path -- reaching an MCP client
// verbatim through `auth/service.ts`'s generic `tool_error` mapping. Both
// readers now treat a missing table as an empty page instead.
export {}; // makes this a module, so top-level `await` typechecks under `tsc`

const kind = process.argv[2];
const payload =
  kind === "calls"
    ? { workspace_name: "svc-alpha", after_id: null, limit: 50, tool: null, status: null, include_total: true }
    : { workspace_name: "svc-alpha", after_id: null, limit: 50, include_total: true };
const bytes = new TextEncoder().encode(JSON.stringify(payload));

const result =
  kind === "calls"
    ? await (await import("../../../src/mcp/calls.listMcpCalls")).listMcpCalls(bytes)
    : await (await import("../../../src/mcp/connections.listConnections")).listConnections(bytes);

console.log(JSON.stringify(result));
