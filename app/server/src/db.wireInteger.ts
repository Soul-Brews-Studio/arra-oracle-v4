// LanceDB can hand back a bigint for a count/attempt column; the wire (JSON)
// format only tolerates a plain number if it is JS-safe, otherwise a string.
export const wireInteger = (value: bigint | number) => {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return Number.isSafeInteger(value) ? value : String(value);
};
