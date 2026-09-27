// #31 audit parity (round 3, 2026-09-27): the one refusal both transports
// raise when a request body names a different workspace than the one the
// caller was admitted for (an alpha route or `/mcp/alpha`, a beta body), or
// names none. MCP answers with this text; HTTP keeps answering its generic
// 400. Both AUDIT this text, so the two rows of one refusal are equal.

/** The body-scope refusal, audited identically by `mcp/index.ts` and `transport.ts`. */
export function bodyScopeRefusal(): Error {
  return new Error("payload workspace_name must match the connected bank");
}
