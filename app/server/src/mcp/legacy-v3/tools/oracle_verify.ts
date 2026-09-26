import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";

/** `reconcileSearchChunks`'s wire shape (`publication/service.reconcileSearchChunks.ts`),
 *  named locally rather than imported: A1 forbids this layer importing
 *  anything from `publication/*`. */
type ReconcileResult = {
  visited: number;
  missing: number;
  missing_revisions: { node_id: string; revision_id: string }[];
  stale: number;
  exhausted: boolean;
  ineligible: number;
};

/**
 * `oracle_verify` (V3-PARITY.md §4.2 slice V2; v3 src/tools/verify.ts, 0 real
 * calls). Maps onto the ONE index-completeness kernel this build has,
 * `reconcileSearchChunks` -- there is no `getSearchFreshness` kernel on this
 * base (no embedding-profile-pin work has landed), so the embedding-digest
 * half of v3's "verify" concept is a GAP, not a field this tool can ever
 * fill: it is not attempted, not invented, and not silently dropped -- named
 * here and in the amendment this slice appends to
 * `app/docs/contracts/search-chunk-v1.md`.
 *
 * v3's `check:false` wrote `superseded_by:'_verified_orphan'`, inventing a
 * successor id v4 never would (a lifecycle event is real evidence, not a
 * housekeeping side effect), so it is `not_carried` rather than approximated.
 * `type` is accepted and ignored (`argument_ignored`): the kernel's sweep
 * always covers every current node, unfiltered.
 */
export async function oracle_verify(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  if (args.check === false) {
    throw new CompatError(context.tool, "not_carried", "check:false is not carried in v4", "v3's check:false invented a successor id ('_verified_orphan'); v4 never invents lifecycle state", { path: "/check" });
  }

  const warnings: { code: string; field: string; detail: string }[] = [];
  if (Object.hasOwn(args, "type") && args.type !== undefined && args.type !== null) {
    warnings.push({ code: "argument_ignored", field: "type", detail: "oracle_verify checks every current entry; a type filter is not carried" });
  }

  const result = (await context.kb("reconcileSearchChunks", { limit: 1024 })) as ReconcileResult;
  if (!result.exhausted) {
    warnings.push({ code: "partial", field: "exhausted", detail: "reconcileSearchChunks did not visit every current node in one page; run oracle_verify again" });
  }
  warnings.push({ code: "field_unavailable", field: "orphaned", detail: "v4 has no equivalent of an orphaned search-cache row; nothing is deleted to check for one" });
  warnings.push({ code: "field_unavailable", field: "untracked", detail: "v4 has no equivalent of an untracked document; every node is tracked by the kernel" });

  return {
    healthy: result.visited - result.missing - result.stale,
    missing: result.missing,
    drifted: result.stale,
    orphaned: null,
    untracked: null,
    missing_documents: result.missing_revisions,
    recommendation:
      result.missing > 0
        ? "run indexRevisionChunks for the node/revision pairs in missing_documents"
        : "no action needed",
    compat_warnings: warnings,
    v4: { visited: result.visited, ineligible: result.ineligible, exhausted: result.exhausted },
  };
}
