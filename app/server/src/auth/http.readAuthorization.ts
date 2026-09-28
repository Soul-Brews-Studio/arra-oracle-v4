/** Exactly one token, no commas, no second scheme, no surrounding whitespace. */
const BEARER = /^[Bb][Ee][Aa][Rr][Ee][Rr] [0-9a-f]{64}$/;

export function readAuthorization(request: Request): string | null {
  const raw = request.headers.get("authorization");
  if (raw === null) return null;
  // A comma means either duplicated headers or a multi-credential value; both
  // are ambiguous after flattening, so both fail closed.
  if (raw.includes(",")) return null;
  return BEARER.test(raw) ? raw : null;
}
