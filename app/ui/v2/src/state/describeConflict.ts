/** `publishRevision`'s `{outcome: "conflict", reason}` arrives as HTTP 200
 *  (`service.types.ts` PublishOutcome) -- it is the server's answer, not a
 *  transport error, so `result.ok` alone cannot tell a refusal from success.
 *  Wave 5 hardening (#33): this was measured reaching the UI as a silent
 *  "success" (it navigated, cleared the form, showed nothing). `useKnowledge`
 *  calls this to turn the refusal into the `error` state a user sees. */
const CONFLICT_REASON_TEXT: Record<string, string> = {
  node_id: "another revision already claims this node id",
  stale_base: "this node was revised by someone else first -- refresh and try again",
  node_retired: "this node was superseded or retired -- publishing here is disabled",
  operation_digest: "a different publish already used this operation id",
};

export function describeConflict(reason: unknown): string {
  const text = typeof reason === "string" ? CONFLICT_REASON_TEXT[reason] : undefined;
  return `publish refused: ${text ?? String(reason)}`;
}
