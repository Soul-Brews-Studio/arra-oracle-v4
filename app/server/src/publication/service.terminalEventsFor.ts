import { failPublication } from "./errors";
import { encodeSupersedeLogRow } from "./lifecycle";
import { quote } from "./storage";
import { SUPERSEDE_LOG } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * #29 slice B (overnight R7): the batch half of the centralized normal-read
 * eligibility rule DESIGN.md §9 describes. Split out of the former
 * `service.evaluateEligibility.ts` in the fix round that followed this
 * slice's first review, which found that file exporting two functions
 * (`terminalEventsFor` and `evaluateNodeEligibility`) neither matching its
 * name -- the one file in `publication/service.*.ts` that broke the "one
 * exported function per file, named after the file" rule. See
 * `service.evaluateNodeEligibility.ts` for the per-node predicate built on
 * top of this.
 *
 * Write-free (AC4): the only table this file ever touches is `supersede_log`,
 * and only ever read, never appended, updated or deleted.
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
