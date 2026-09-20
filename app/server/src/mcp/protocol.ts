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

/** Revisions we know how to speak. Anything else still gets an answer — in the
 *  newest of these — rather than silence. Kept in sync with digger-node. */
export const KNOWN_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const SERVER_NAME = "arra-oracle-v4";
export const SERVER_VERSION = "26.9.20-alpha.1625";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
export const err = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Lance stores int64, and the JS client hands those back as BigInt, which
 *  `JSON.stringify` refuses outright — "cannot serialize BigInt". Every tool
 *  returning a row hit this, so the conversion belongs HERE, at the one place
 *  every result passes through, not in each tool.
 *
 *  Values inside JS's safe-integer range remain numbers. Larger int64 values
 *  stay exact as decimal strings rather than being silently rounded. */
const bigintSafe = (_k: string, v: unknown) => {
  if (typeof v !== "bigint") return v;
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(v)
    : v.toString();
};

/** MCP tool results are content blocks, not bare JSON. */
export const text = (value: unknown) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, bigintSafe, 2),
    },
  ],
});

export function negotiate(asked: unknown): string {
  const want = String(asked ?? "");
  return (KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(want)
    ? want
    : KNOWN_PROTOCOL_VERSIONS[0];
}
