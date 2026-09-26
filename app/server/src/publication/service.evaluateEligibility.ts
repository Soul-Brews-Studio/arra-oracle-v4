import { failPublication } from "./errors";
import { encodeSupersedeLogRow } from "./lifecycle";
import { encodeNodeRow, encodeRevisionRow } from "./rows";
import { quote } from "./storage";
import { NODES, NODE_REVISIONS, SUPERSEDE_LOG } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * #29 slice B (overnight R7): the centralized normal-read eligibility rule
 * DESIGN.md §9 describes and no ordinary read applied before tonight --
 * `getRecallEligibility` checked only "does a supersede_log row exist",
 * ignoring `is_active` and the validity window entirely (measured in
 * `.tmp/understand/analysis-29.json`, eligibility-rule.test.ts op3-op5).
 *
 * Both exports here are write-free (AC4): neither calls `refresh` on
 * anything but the two read-only tables it queries, and nothing in this
 * file ever appends, updates or deletes a row.
 */

export type LifecycleKind = "retired" | "superseded";

/** One node's own terminal event, decoded. */
export type LifecycleEvent = {
  event_id: string;
  kind: LifecycleKind;
  /** Both null for a retirement; both a nanoid21 for a supersession --
   *  `encodeSupersedeLogRow` has already proven the pair agrees. */
  new_id: string | null;
  new_revision_id: string | null;
  reason: string;
  superseded_at: string;
};

/** Additive label for a node's own terminal event, or null when it has
 *  none. Shared by `evaluateNodeEligibility`, `getAcceptedHead` and
 *  `listAcceptedHistory` -- one shape, one place it is built. */
export type LifecycleLabel = LifecycleEvent | null;

export type EligibilityReason = "retired" | "superseded" | "inactive" | "not_yet_valid" | "expired";

export type EligibilityResult = {
  eligible: boolean;
  reasons: EligibilityReason[];
  head_revision_id: string;
  lifecycle: LifecycleLabel;
};

function labelFromRow(encoded: Record<string, unknown>): LifecycleEvent {
  const newId = encoded.new_id as string | null;
  return {
    event_id: encoded.id as string,
    kind: newId === null ? "retired" : "superseded",
    new_id: newId,
    new_revision_id: encoded.new_revision_id as string | null,
    reason: encoded.reason as string,
    superseded_at: encoded.superseded_at as string,
  };
}

/**
 * One `supersede_log` query for a whole PAGE of node ids -- `old_id IN
 * (...)`, never one query per node (#29 slice B, fix plan B1). Returns a Map
 * keyed by node id, present only for a node that actually carries a
 * terminal event. Also the single-node lookup: callers with exactly one id
 * (`evaluateNodeEligibility`, `getAcceptedHead`, `supersedeNode`'s successor
 * check) call this the same way, with a one-element array.
 *
 * `old_id` is scoped-unique per the writer's own append-only rule
 * (`writeLifecycleEventFresh`'s `already_terminal` check), so a duplicate
 * hit for one id here is stored corruption, not a caller mistake -- the same
 * `integrity_failure` `getRecallEligibility` already raised for its own
 * `limit 2` lookup before this slice.
 */
export async function terminalEventsFor(
  reader: DatasetAdapter,
  workspace: string,
  ids: readonly string[],
): Promise<Map<string, LifecycleEvent>> {
  const out = new Map<string, LifecycleEvent>();
  if (ids.length === 0) return out;
  await reader.refresh(SUPERSEDE_LOG);
  const list = ids.map((id) => quote(id)).join(", ");
  const rows = await reader.query(
    SUPERSEDE_LOG,
    `${contextScope(workspace)} AND old_id IN (${list})`,
    ids.length,
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const encoded = encodeSupersedeLogRow(row);
    const oldId = encoded.old_id as string;
    if (seen.has(oldId)) failPublication("integrity_failure", "");
    seen.add(oldId);
    out.set(oldId, labelFromRow(encoded));
  }
  return out;
}

/**
 * DESIGN.md §9's five recall-eligibility predicates, centralized:
 *
 *   authorized workspace AND accepted current revision AND revision.is_active
 *   AND within valid_from/valid_to when present AND not explicitly replaced
 *   or retired
 *
 * The first two are the caller's own resolution of `workspace`/`nodeId`
 * (this function re-resolves them itself so it is safe to call standalone);
 * the rest are decided here. The validity window is a HALF-OPEN interval,
 * `[valid_from, valid_to)`, at `asOf`: a revision becomes valid AT its
 * `valid_from` instant and stops being valid AT (not after) its `valid_to`
 * instant, matching the append-only, never-ambiguous style the rest of this
 * kernel uses for boundaries.
 *
 * `asOf` is a plain epoch-millisecond number the CALLER resolves --
 * `lifecycle-v1.md`'s "readers take no clock" rule is honored by
 * construction: the value arrives as an ordinary argument, exactly like
 * `options.clock()`'s sampled value on the write side, never sampled here.
 * The overnight R7 ruling has the TRANSPORT (`knowledge/registry.ts`, the
 * one dispatch point both HTTP and MCP call through) supply real request
 * time; nothing in this file, or in `service.getRecallEligibility.ts`, ever
 * calls `Date.now()`.
 */
export async function evaluateNodeEligibility(
  reader: DatasetAdapter,
  workspace: string,
  nodeId: string,
  asOf: number,
): Promise<EligibilityResult> {
  await reader.refresh(NODES);
  const node = await contextOne(reader, NODES, `${contextScope(workspace)} AND id = ${quote(nodeId)}`);
  if (node === null) failPublication("invalid_reference", "/node_id");
  const encodedNode = encodeNodeRow(node);
  const headId = encodedNode.current_revision_id;
  if (typeof headId !== "string") failPublication("integrity_failure", "");

  await reader.refresh(NODE_REVISIONS);
  const revision = await contextOne(
    reader,
    NODE_REVISIONS,
    `${contextScope(workspace)} AND id = ${quote(headId)}`,
  );
  if (revision === null) failPublication("integrity_failure", "");
  const encodedRevision = encodeRevisionRow(revision);

  const lifecycle = (await terminalEventsFor(reader, workspace, [nodeId])).get(nodeId) ?? null;

  const reasons: EligibilityReason[] = [];
  if (lifecycle !== null) reasons.push(lifecycle.kind);
  if (encodedRevision.is_active !== true) reasons.push("inactive");
  const validFrom = encodedRevision.valid_from as string | null;
  const validTo = encodedRevision.valid_to as string | null;
  if (validFrom !== null && asOf < Date.parse(validFrom)) reasons.push("not_yet_valid");
  if (validTo !== null && asOf >= Date.parse(validTo)) reasons.push("expired");

  return { eligible: reasons.length === 0, reasons, head_revision_id: headId, lifecycle };
}
