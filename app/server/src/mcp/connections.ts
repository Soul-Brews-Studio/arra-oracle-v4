// The connection fold (#102) — one row per caller, not one row per call.
//
//   `mcp_calls` answers "what happened". `connections` answers "who is here".
//   Both are in the enforced 19; only the first had a writer, so the second
//   read zero forever and the overview page had to explain the zero rather
//   than show it.
//
// A fold, deliberately, not a log: `mcp_calls` already carries the per-call
// detail, and duplicating it here would make the table grow with traffic while
// answering a question nobody asks of it. What is missing from the call log is
// the SHAPE of the caller population — how many distinct principals, on which
// transport, first seen when, how much of their traffic is tool calls. That is
// bounded by the number of callers, not by the number of requests.
//
// Split (Nat style, one exported function per file, style-server-split2):
// this file is now a re-export barrel so importers and any citation of
// `server/src/mcp/connections.ts` do not churn. The three functions live in
// connections.foldConnection.ts, connections.connectionFoldFailureCount.ts
// and connections.resetConnectionFoldState.ts; shared mutable state lives in
// connections.state.ts. Split files import each other directly, never
// through this barrel.
export { foldConnection } from "./connections.foldConnection";
export { connectionFoldFailureCount } from "./connections.connectionFoldFailureCount";
export { resetConnectionFoldState } from "./connections.resetConnectionFoldState";
export type { ConnectionEvent } from "./connections.state";
