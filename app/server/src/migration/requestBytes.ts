/** Kernel methods take raw request bytes, exactly as a transport would send them. */
export function requestBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
