import { ERROR_BODIES } from "./http.types";

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
