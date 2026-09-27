/**
 * The text an audit row records for a failed call (#31).
 *
 * A governed envelope error (arra-error/v1, arra-publication-error/v1,
 * arra-taxonomy-error/v1) is recorded as its exact JSON, the same text the
 * transport answers with; anything else as its message. One copy, shared by
 * `service.ts` (`runMcp` and the legacy HTTP routes) and
 * `knowledge/transport.auditKnowledgeCall.ts`, so the transports cannot drift.
 */
export function auditErrorText(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { path?: unknown }).path === "string" &&
    typeof (error as { toJSON?: unknown }).toJSON === "function"
  ) {
    return JSON.stringify((error as { toJSON(): unknown }).toJSON());
  }
  return error instanceof Error ? error.message : String(error);
}
