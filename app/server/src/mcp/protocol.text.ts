// Split from protocol.ts (style-split4b, 2026-09-28): MCP tool result content-block wrapper.

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
