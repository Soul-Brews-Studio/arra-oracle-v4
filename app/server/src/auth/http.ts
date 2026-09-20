/**
 * Bounded raw-transport helpers (`authorization-integration-v1.md` §2, §5).
 *
 * These run BEFORE any body is read. The route sets `parse: "none"` so the
 * framework performs no decoding of its own, and everything below operates on
 * the untouched request stream with an explicit byte ceiling.
 *
 * On header grammar: Bun's Fetch Request exposes headers AFTER comma-joining
 * duplicates, so this cannot count raw header lines. It is a post-flattening
 * fail-closed grammar gate — a comma-bearing value is rejected whether it came
 * from two header lines or one. That is deliberately weaker than a raw-wire
 * multiplicity proof and must not be described as one.
 */

export const MAX_BODY_BYTES = 256 * 1024;
/** Read one byte past the cap so cap and cap+1 are distinguishable. */
const READ_CEILING = MAX_BODY_BYTES + 1;

export type TransportRejection = { readonly status: number; readonly error: string };

const reject = (status: number, error: string): TransportRejection => Object.freeze({ status, error });

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

/** Host must match the configured authority exactly; Origin, if present, too. */
export function checkHostAndOrigin(request: Request, origin: URL): TransportRejection | null {
  const host = request.headers.get("host");
  if (host === null || host.includes(",") || host !== origin.host) {
    return reject(400, "bad host");
  }
  const suppliedOrigin = request.headers.get("origin");
  if (suppliedOrigin === null) return null; // absent is valid for CLI and MCP
  if (suppliedOrigin.includes(",") || suppliedOrigin === "null") return reject(403, "bad origin");
  if (suppliedOrigin !== origin.origin) return reject(403, "bad origin");
  return null;
}

/** Strip one layer of double quotes from a media-type parameter value. */
const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

export function checkBodyEncoding(request: Request): TransportRejection | null {
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    return reject(415, "unsupported content encoding");
  }
  const type = request.headers.get("content-type");
  if (type === null) return reject(415, "unsupported content type");
  // A comma means duplicated Content-Type header lines after flattening.
  if (type.includes(",")) return reject(415, "unsupported content type");

  const [base, ...parameters] = type.split(";");
  if (base === undefined || base.trim().toLowerCase() !== "application/json") {
    return reject(415, "unsupported content type");
  }

  // Parse parameters EXACTLY: exactly one optional charset, which must be
  // UTF-8, and no other parameter at all. A first-match regex was accepting
  // `charset=utf-8;charset=latin1` and `foo=bar`, which is how an unsupported
  // or conflicting encoding could reach the parser.
  let sawCharset = false;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (trimmed === "") return reject(415, "unsupported content type");
    const eq = trimmed.indexOf("=");
    if (eq === -1) return reject(415, "unsupported content type");
    const name = trimmed.slice(0, eq).trim().toLowerCase();
    const value = unquote(trimmed.slice(eq + 1).trim()).toLowerCase();
    if (name !== "charset") return reject(415, "unsupported content type");
    if (sawCharset) return reject(415, "unsupported content type"); // duplicate
    if (value !== "utf-8" && value !== "utf8") return reject(415, "unsupported content type");
    sawCharset = true;
  }
  return null;
}

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

export type RawBody = { readonly bytes: Uint8Array } | TransportRejection;

export const isRejection = (value: RawBody): value is TransportRejection =>
  (value as TransportRejection).status !== undefined;

/**
 * Read at most MAX_BODY_BYTES from the untouched stream, cancelling as soon as
 * the ceiling is passed rather than buffering the whole message first.
 *
 * One runtime-delivered chunk may transiently exceed the cap; this bounds what
 * is RETAINED and stops reading promptly. It is not a process-memory sandbox.
 */
export async function readBoundedBody(request: Request): Promise<RawBody> {
  const stream = request.body;
  if (stream === null) return { bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return reject(413, "payload too large");
      }
      chunks.push(value);
      if (total > READ_CEILING) break;
    }
  } catch {
    return reject(400, "malformed request");
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/** Fixed, small, secret-free bodies. Never echoes caller content. */
export const ERROR_BODIES: Readonly<Record<number, { error: string }>> = Object.freeze({
  400: { error: "bad request" },
  401: { error: "unauthenticated" },
  403: { error: "forbidden" },
  413: { error: "payload too large" },
  415: { error: "unsupported media type" },
  503: { error: "policy unavailable" },
});

export function errorResponse(status: number, extraHeaders: Record<string, string> = {}): Response {
  const body = ERROR_BODIES[status] ?? { error: "error" };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extraHeaders,
  };
  if (status === 401) headers["www-authenticate"] = 'Bearer realm="arra"';
  return new Response(JSON.stringify(body), { status, headers });
}
