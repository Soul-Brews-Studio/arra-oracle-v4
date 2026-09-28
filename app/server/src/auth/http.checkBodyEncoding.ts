import type { TransportRejection } from "./http.types";
import { reject } from "./http.reject";

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
