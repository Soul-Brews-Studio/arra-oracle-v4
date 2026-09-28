/**
 * MCP adapter (`authorization-integration-v1.md` §1, §3).
 *
 * This module maps JSON-RPC envelopes onto the operation service and shapes the
 * replies. It never receives a gate, an Admission or a request context, and it
 * does not choose which action a tool needs -- the service owns that map.
 *
 * It is NOT authority-free, and the earlier comment claiming so was wrong: the
 * dispatcher below receives scope-bound callable operations, and a callable
 * operation IS authority. What bounds it is enforced on the service side --
 * each operation re-checks the admitted action, and the whole set is
 * invalidated when the request ends.
 *
 * Re-export barrel (style-split5b, 2026-09-28, #22): each exported function
 * moved VERBATIM to its own `index.<fn>.ts` file; the `knowledgeAccess`
 * module state moved to `index.state.ts` with one identity. This file
 * remains an ADAPTER_FILES entry (app/migrate-py/tests/test_revision_v1.py)
 * -- the split files that now hold the real dispatch logic
 * (`index.dispatchTool.ts`, `index.createMcpAdapter.ts`) are added to that
 * same list so a raw `./db`/`./storage`/`./calls` import landing in either
 * would still be caught.
 */
export { configureKnowledgeAccess } from "./index.configureKnowledgeAccess";
export { dispatchTool } from "./index.dispatchTool";
export { createMcpAdapter, type McpOutcome } from "./index.createMcpAdapter";
export { handshakeResponse } from "./index.handshakeResponse";
