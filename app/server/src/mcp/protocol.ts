// MCP transport, hand-rolled against the JSON-RPC wire.
//
// NOT the SDK, and that is a decision with a reason (digger-node/src/mcp.ts made
// the same one): this is ONE stateless POST endpoint. The SDK's transport layer
// exists to manage sessions v4 does not want, and pinning it means inheriting
// its version churn.
//
// ── protocolVersion, the trap this fleet fell into three times ───────────────
//
// A client sends the revision it speaks. Three servers in this fleet answered
// with THEIR revision, and clients speaking a newer one connected, listed ZERO
// tools, and reported no error on either side — a silent, symptomless failure
// that took four wrong fixes to find once.
//
// So: echo the client's requested revision when we recognise its era, and fall
// back to our newest known one otherwise. NEVER hard-code one and reject the
// rest. There is no MCP "v2" (SPEC §6.1) — the spec is date-revisioned, and the
// SERVER is what carries a version number.
//
// This file is now a barrel (style-split4b, 2026-09-28): each exported function
// moved verbatim to its own protocol.<fn>.ts, and the shared constants/types
// moved to protocol.state.ts (data only). Re-exported here so every existing
// importer (`./mcp/protocol` / `../src/mcp/protocol`) keeps working unchanged,
// including SERVER_NAME/SERVER_VERSION, which app.createApp.ts and mcp/index.ts
// import from this path.

export { KNOWN_PROTOCOL_VERSIONS, SERVER_NAME, SERVER_VERSION } from "./protocol.state";
export type { JsonRpcRequest } from "./protocol.state";
export { ok } from "./protocol.ok";
export { err } from "./protocol.err";
export { text } from "./protocol.text";
export { negotiate } from "./protocol.negotiate";
