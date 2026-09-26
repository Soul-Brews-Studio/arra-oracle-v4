import { failPublication } from "./errors";
import { encodeNodeRow, encodeRevisionRow } from "./rows";
import { quote } from "./storage";
import { NODES, NODE_REVISIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { terminalEventsFor, type LifecycleLabel } from "./service.terminalEventsFor";
import { type DatasetAdapter } from "./service.types";

/**
 * #29 slice B (overnight R7): the centralized normal-read eligibility rule
 * DESIGN.md §9 describes and no ordinary read applied before tonight --
 * `getRecallEligibility` checked only "does a supersede_log row exist",
 * ignoring `is_active` and the validity window entirely (measured in
 * `.tmp/understand/analysis-29.json`, eligibility-rule.test.ts op3-op5).
 *
 * Split out of the former `service.evaluateEligibility.ts` in the fix round
 * that followed this slice's first review (see `service.terminalEventsFor.ts`
 * for the batch helper this builds on): that file exported two functions,
 * neither matching its own name, breaking the "one exported function per
 * file, named after the file" rule the rest of `publication/service.*.ts`
 * follows.
 *
 * Write-free (AC4): the only tables this file ever touches are `nodes` and
 * `node_revisions`, both read-only here, plus `terminalEventsFor`'s own
 * read-only `supersede_log` query.
 */

export type EligibilityReason = "retired" | "superseded" | "inactive" | "not_yet_valid" | "expired";

export type EligibilityResult = {
  eligible: boolean;
  reasons: EligibilityReason[];
  head_revision_id: string;
  lifecycle: LifecycleLabel;
};

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
 * time; THIS file never calls `Date.now()` itself, on any path. Fix round
 * correction: an earlier version of this comment (and one in `registry.ts`)
 * claimed `service.getRecallEligibility.ts` never does either, which is
 * false -- its own `requestTimeMs ?? Date.now()` fallback does, for every
 * caller that omits the parameter. That fallback exists only for a handful
 * of pre-existing in-process test harnesses that call every context method
 * with a single argument, and is documented at its own definition; every
 * LIVE call still goes through the registry's explicit `Date.now()`, never
 * through this fallback.
 *
 * A non-finite `asOf` (fix round: a mutation test found `NaN` silently made
 * every window comparison below false, reading as eligible) is refused as
 * `invalid_request` at root -- the same treatment `writeLifecycleEventFresh`
 * gives an invalid sampled clock value, since `asOf` is operator/transport
 * configuration, not a caller-controlled request field.
 */
export async function evaluateNodeEligibility(
  reader: DatasetAdapter,
  workspace: string,
  nodeId: string,
  asOf: number,
): Promise<EligibilityResult> {
  if (typeof asOf !== "number" || !Number.isFinite(asOf)) failPublication("invalid_request", "");

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
