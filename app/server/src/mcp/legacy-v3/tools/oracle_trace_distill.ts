import { cleanNames } from "../cleanNames";
import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { resolveTraceId } from "../ids.resolveTraceId";
import { normalizeProject } from "../normalizeProject";
import { publish } from "../publish";
import { titleOf } from "../titleOf";

/**
 * `oracle_trace_distill` (0 real calls; V3-PARITY.md §4.3, DECISIONS.md R18
 * D4; v3 `src/tools/oracle.ts:20-38`, `src/trace/distill.ts:93-130`).
 *
 * A NEW node `derived_from` the trace -- `learning` when promoted, else
 * `conclusion` (R10) -- never a mutation of the trace itself, which is
 * immutable in v4. Re-distilling therefore adds a SECOND node; the trace
 * row's own bytes never change (v3 rewrote `awakening`/`status` in place on
 * the trace row; v4 has no such columns, and "distilled" is derived instead
 * from this `derived_from` link, `oracle_trace_get`'s own job).
 *
 * v3's Thor/Stormforge persona defaults (`oracleOrigin`, `defaultConcepts`)
 * are dropped (§4.3, §6): v4 has no profile registry (AGENTS rule 4). The
 * caller's own `origin` argument is used as the author ONLY when it names
 * the bound speaking peer; otherwise it is kept, informational only, in the
 * new node's `fields.origin` -- never silently discarded.
 */
export async function oracle_trace_distill(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const trace = await resolveTraceId(context.kb, args.traceId, context.tool);
  if (trace === null) {
    throw new CompatError(context.tool, "kernel_error", `Trace ${String(args.traceId)} not found`, "no trace with this id exists in this bank", { path: "/traceId" });
  }
  const awakening = typeof args.awakening === "string" ? args.awakening.trim() : "";
  if (awakening === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /awakening: awakening is required", "v3's own rule: a nonblank awakening", { path: "/awakening" });
  }
  const promote = args.promoteToLearning === true;
  const author = await ensureSpeaker(context, args);

  const concepts = ["trace-awakening"];
  if (typeof args.theme === "string" && args.theme.trim() !== "") concepts.push(args.theme.trim());
  concepts.push(...cleanNames(args.concepts));

  const originArg = typeof args.origin === "string" && args.origin.trim() !== "" ? args.origin.trim() : null;
  const originIsSpeaker = originArg !== null && originArg === author;

  const done = await publish(context, {
    title: titleOf(awakening),
    body: awakening,
    fields: originArg !== null && !originIsSpeaker ? { origin: originArg } : {},
    terms: { type: promote ? "learning" : "conclusion", concepts, project: normalizeProject(args.project) },
    links: [
      {
        relation: "derived_from",
        target_kind: "trace",
        target: { trace_id: trace.id },
        capture_status: "locator_only",
        excerpt: null,
        content_hash: null,
        captured_at: null,
        note: null,
      },
    ],
    author,
    sessionName: null,
    changeReason: `distilled from trace ${trace.id as string}`,
    idempotencyKey: args.idempotency_key,
    // K5's `derived_from_count` (`oracle_trace_list`'s `has_awakening`,
    // `oracle_trace_get`'s `status`/`chain` summaries) reads the RECONCILED
    // `revision_links` projection, not the live snapshot: reconcile this
    // one revision right away, the same way `publish()` already indexes for
    // search at once.
    reconcile: true,
  });

  const result: Record<string, unknown> = { success: true, status: "distilled" };
  if (promote) {
    result.learningId = done.node_id;
    result.origin = originArg ?? author ?? "arra-v3-compat/1";
    result.concepts = concepts;
  }
  return result;
}
