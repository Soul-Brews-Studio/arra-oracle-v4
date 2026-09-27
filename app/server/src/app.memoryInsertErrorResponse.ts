import { knowledgeErrorResponse } from "./knowledge/transport";

/**
 * D5a HTTP parity: `insertMemory`'s taxonomy check (`StoreDependencies.validateType`)
 * throws the SAME closed `arra-taxonomy-error/v1` envelope MCP `remember` does;
 * propagated UNCHANGED here, same as the `kb_*` routes, rather than falling
 * through to `denialResponse`'s generic `policy_unavailable` 503 for anything
 * it does not recognise. Split out of `app.ts` to stay under this repo's
 * per-file line cap.
 */
export function memoryInsertErrorResponse(error: unknown, denialResponse: (error: unknown) => Response): Response {
  const taxonomy = knowledgeErrorResponse(error);
  if (taxonomy !== null) return taxonomy;
  return denialResponse(error);
}
