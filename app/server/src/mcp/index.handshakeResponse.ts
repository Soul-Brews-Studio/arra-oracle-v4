import { SERVER_NAME, SERVER_VERSION, negotiate, ok } from "./protocol";

/** Envelope shaping for handshake methods, which need no tool authority. */
export function handshakeResponse(method: string, id: string | number | null, params: Record<string, unknown>) {
  if (method === "initialize") {
    return Response.json(
      ok(id, {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    );
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return new Response(null, { status: 202 });
  }
  if (method === "ping") return Response.json(ok(id, {}));
  return null;
}
