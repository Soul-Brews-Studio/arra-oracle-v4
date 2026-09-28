import type { TransportRejection } from "./http.types";
import { reject } from "./http.reject";

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
