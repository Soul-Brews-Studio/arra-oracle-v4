// Local copy of `migration/requestBytes.ts`'s one-liner: kernel methods take
// raw request bytes, exactly as a transport would send them. Duplicated
// (not imported from `migration/`) because `migration/` is operator-only
// (test_revision_v1.py's reachability scan refuses any OTHER server source
// from naming it in a module specifier) -- `db.legacyRead.*` is a request-
// path read, reachable from `/api/memories` and the v3-compat tools, so it
// must not be a `migration/` consumer.
export function requestBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
