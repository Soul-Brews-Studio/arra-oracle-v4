// Shared by calls.truncate.ts (JSON encoding of a call record before it is
// logged) and calls.recent.ts (decoding stored bigint columns back out).
export const safeInteger = (value: bigint) =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
