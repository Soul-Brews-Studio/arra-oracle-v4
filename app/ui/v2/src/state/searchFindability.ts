/** What `useSearchFreshness` read from `getRecallEligibility` for the node on
 *  screen. A failed read is carried, not thrown: the chunk state is still
 *  known when only eligibility is not. `body` stays `unknown` until checked. */
export type EligibilityRead = { ok: true; body: unknown } | { ok: false; message: string };

/** Whether search RETURNS the node -- a separate fact from its chunk state.
 *
 *   searchable     -- recall-eligible and chunked: at least keyword search
 *                     can return it (the text says which search can)
 *   not_searchable -- recall-eligible, but no chunk exists yet
 *   excluded       -- NOT recall-eligible: both searches filter it out,
 *                     whatever its chunks say
 *   unknown        -- eligibility could not be read, or came back in a shape
 *                     this UI does not know; never a findability claim */
export type SearchFindability = {
  state: "searchable" | "not_searchable" | "excluded" | "unknown";
  text: string;
};

/** `service.evaluateNodeEligibility.ts` EligibilityReason, in words. */
const REASON: Record<string, string> = {
  retired: "retired",
  superseded: "superseded",
  inactive: "inactive (its head revision has is_active false)",
  not_yet_valid: "not valid yet (its valid_from is still ahead)",
  expired: "expired (past its valid_to)",
};

function asEligibility(body: unknown): { eligible: boolean; reasons: string[] } | null {
  if (typeof body !== "object" || body === null) return null;
  const { eligible, reasons } = body as { eligible?: unknown; reasons?: unknown };
  if (typeof eligible !== "boolean") return null;
  // `reasons` is lifecycle-v1's additive field (#29 slice B): absent is
  // allowed (an older server), present-but-not-a-string-list is not.
  if (reasons === undefined) return { eligible, reasons: [] };
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === "string")) return null;
  return { eligible, reasons };
}

/** Fix round (2026-09-27, verifier REFUTED the first cut): "every chunk
 *  ready" was rendered as "keyword and semantic search can both find this
 *  revision", but search drops any node that is not recall-eligible
 *  (`service.currentEligibleChunks.ts` step 3, the same
 *  `evaluateNodeEligibility` rule `getRecallEligibility` answers), and a
 *  retired, superseded, inactive or out-of-window head is still readable, so
 *  the panel shows for it. Measured on the real gated server: a retired node
 *  and an `is_active: false` node, both fully embedded, got `{"hits":[]}`
 *  from keyword and semantic search.
 *
 * So a positive findability sentence is made ONLY for an eligible node. The
 * chunk facts it leans on are the server's: keyword search reads chunk text
 * whatever the vector status; semantic search reads only `status = 'ready'`
 * chunks (`service.searchKnowledgeSemantic.ts`). Eligibility is judged at the
 * server's request time, so a validity window can close after this read --
 * "re-check" re-reads it. */
export function searchFindability(
  read: EligibilityRead,
  chunks: { total: number; ready: number },
): SearchFindability {
  if (!read.ok) {
    return {
      state: "unknown",
      text: `Whether search returns this node is unknown: recall eligibility could not be read (${read.message}).`,
    };
  }
  const e = asEligibility(read.body);
  if (e === null) {
    return {
      state: "unknown",
      text: "Whether search returns this node is unknown: getRecallEligibility answered in a shape this view does not know.",
    };
  }
  if (!e.eligible) {
    const why =
      e.reasons.length === 0
        ? "not recall-eligible (the server gave no reason)"
        : e.reasons.map((r) => REASON[r] ?? r).join(", ");
    return {
      state: "excluded",
      text: `Search does not return this node: it is ${why}. Keyword and semantic search both filter it out, whatever its chunks say.`,
    };
  }
  if (chunks.total === 0) {
    return {
      state: "not_searchable",
      text: "Recall-eligible, but not chunked yet: neither keyword nor semantic search returns it until it is.",
    };
  }
  const missing = chunks.total - chunks.ready;
  return {
    state: "searchable",
    text:
      missing === 0
        ? "Recall-eligible: keyword and semantic search can both return this revision."
        : `Recall-eligible: keyword search can return it from its chunk text; semantic search skips ${missing} chunk${missing === 1 ? "" : "s"} without a vector.`,
  };
}
