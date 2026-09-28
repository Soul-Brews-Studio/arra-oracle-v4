// Split from protocol.ts (style-split4b, 2026-09-28): one JSON-RPC error envelope.
export const err = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
