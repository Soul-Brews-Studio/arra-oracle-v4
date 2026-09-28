// Split from protocol.ts (style-split4b, 2026-09-28): one JSON-RPC success envelope.
export const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
