// #31 legacy-audit (2026-09-27): the refusal both transports audit for a
// knowledge request whose scope does not match. A payload that is not a JSON
// object (`[]`, a scalar) is "payload must be an object", which MCP has
// always raised for it (`mcp/index.ts`); HTTP audited the body-scope text for
// it instead, so the two rows disagreed. Any object whose `workspace_name`
// does not match is the body-scope refusal. HTTP still answers its generic
// 400 either way: only the audited text is aligned.

import { bodyScopeRefusal } from "./transport.bodyScopeRefusal";

/** The refusal for `payload`, already decoded, that failed the scope check or is no object. */
export function payloadRefusal(payload: unknown): Error {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? bodyScopeRefusal()
    : new Error("payload must be an object");
}
