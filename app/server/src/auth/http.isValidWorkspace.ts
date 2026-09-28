/**
 * The workspace grammar, applied to EVERY scope carrier before policy I/O.
 *
 * A malformed scope is a malformed request (400), not a policy failure: an
 * over-long bank was reaching the loader and surfacing as 503, which both
 * misreports the cause and does needless file work for a doomed request.
 */
export function isValidWorkspace(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (new TextEncoder().encode(value).byteLength > 256) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
