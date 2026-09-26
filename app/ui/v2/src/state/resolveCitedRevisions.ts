import {
  type AssociationLinkRow,
  associationsOf,
  getRecallEligibility,
  getRevisionAssociations,
  recallEligibilityOf,
} from "../api/evidenceReview";
import type { Bank } from "../api/memory";
import { describeResult } from "./describeResult";
import type { CitedRevisionStatus } from "./evidenceStatus.types";

/** At most this many distinct targets are looked up per panel load; the rest
 *  are labelled `not_checked` instead of silently skipped. A revision's link
 *  list is bounded only by the 1 MiB document limit, and each target costs up
 *  to two requests. Shared with `resolveCitingNodes`. */
export const MAX_STATUS_LOOKUPS = 32;

function parseNodeRevisionTarget(target: string): { node_id: string; revision_id: string } | null {
  try {
    const t = JSON.parse(target) as { node_id?: unknown; revision_id?: unknown };
    return typeof t.node_id === "string" && typeof t.revision_id === "string"
      ? { node_id: t.node_id, revision_id: t.revision_id }
      : null;
  } catch {
    return null;
  }
}

async function resolveOne(b: Bank, target: string): Promise<CitedRevisionStatus> {
  const parsed = parseNodeRevisionTarget(target);
  if (parsed === null) return { kind: "lookup_failed", error: "malformed node_revision target" };
  // The EXACT cited revision, not the head: `null` from here means that
  // revision is not on the node's accepted history (or the node is gone).
  const assoc = await getRevisionAssociations(b, parsed.node_id, parsed.revision_id);
  if (!assoc.ok) return { kind: "lookup_failed", error: describeResult(assoc) };
  const found = associationsOf(assoc);
  if (found === null) return { kind: "not_found" };
  const recall = await getRecallEligibility(b, parsed.node_id);
  const verdict = recall.ok ? recallEligibilityOf(recall) : null;
  return {
    kind: "resolved",
    isHead: found.is_snapshot_head,
    headRevisionId: found.snapshot_head_revision_id,
    eligible: verdict?.eligible ?? null,
    eligibilityError: verdict !== null ? null : recall.ok ? "malformed recall eligibility response" : describeResult(recall),
  };
}

/** The live state of every `node_revision` target a revision cites, keyed by
 *  `target_key` (the codec's identity digest, so two links to the same
 *  revision share one lookup). Feeds `directEvidenceLabels` (#33 AC3). Other
 *  target kinds are not in the map: nothing outside this dataset is checked.
 *  Never throws -- a failed read becomes `lookup_failed`, labelled as such. */
export async function resolveCitedRevisions(
  b: Bank,
  links: readonly AssociationLinkRow[],
): Promise<Map<string, CitedRevisionStatus>> {
  const targets = new Map<string, string>();
  for (const l of links) {
    if (l.target_kind === "node_revision" && !targets.has(l.target_key)) targets.set(l.target_key, l.target);
  }
  const out = new Map<string, CitedRevisionStatus>();
  const entries = [...targets];
  for (const [key] of entries.slice(MAX_STATUS_LOOKUPS)) {
    out.set(key, { kind: "not_checked", reason: `only the first ${MAX_STATUS_LOOKUPS} cited revisions are checked` });
  }
  const checked = await Promise.all(
    entries.slice(0, MAX_STATUS_LOOKUPS).map(async ([key, target]) => [key, await resolveOne(b, target)] as const),
  );
  for (const [key, status] of checked) out.set(key, status);
  return out;
}
