import { cleanNames } from "../cleanNames";
import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { resolveTraceId } from "../ids.resolveTraceId";
import { normalizeProject } from "../normalizeProject";
import { publish } from "../publish";
import { titleOf } from "../titleOf";

/** v3 arguments with no v4 home (v3 `src/tools/oracle.ts:21-37`). */
const V3_PROFILE_ARGS = ["finding", "metadata", "oracle", "source"] as const;

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
 *
 * v3's `oracle`, `source`, `finding` and `metadata` arguments fed the
 * Thor/Stormforge profile and artifact paths, which are not carried; each
 * one present is named `argument_ignored`, never dropped silently.
 *
 * FIX (overnight R18 fix round): the distilled node's `project` term comes
 * from the TRACE's own `h_metadata.project` (v3's `distill.ts` used
 * `trace.project`, the row it was distilling FROM), never from
 * `args.project` -- neither v3's real call shape nor this tool's own
 * `inputSchema` has a `project` argument, so reading one off `args` always
 * produced `_universal`, even for a trace `oracle_trace` recorded a real
 * project on.
 */
export async function oracle_trace_distill(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const trace = await resolveTraceId(context.kb, args.traceId, context.tool);
  if (trace === null) {
    throw new CompatError(context.tool, "no_results", `Trace ${String(args.traceId)} not found`, "no trace with this id exists in this bank", { path: "/traceId" });
  }
  const awakening = typeof args.awakening === "string" ? args.awakening.trim() : "";
  if (awakening === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /awakening: awakening is required", "v3's own rule: a nonblank awakening", { path: "/awakening" });
  }
  const promote = args.promoteToLearning === true;
  const author = await ensureSpeaker(context, args);
  const traceMeta = typeof trace.h_metadata === "string" ? (JSON.parse(trace.h_metadata) as Record<string, unknown>) : {};

  const concepts = ["trace-awakening"];
  if (typeof args.theme === "string" && args.theme.trim() !== "") concepts.push(args.theme.trim());
  concepts.push(...cleanNames(args.concepts));

  const originArg = typeof args.origin === "string" && args.origin.trim() !== "" ? args.origin.trim() : null;
  const originIsSpeaker = originArg !== null && originArg === author;

  const done = await publish(context, {
    title: titleOf(awakening),
    body: awakening,
    fields: originArg !== null && !originIsSpeaker ? { origin: originArg } : {},
    terms: { type: promote ? "learning" : "conclusion", concepts, project: normalizeProject(traceMeta.project) },
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
  const ignored = V3_PROFILE_ARGS.filter((key) => Object.hasOwn(args, key));
  if (ignored.length > 0) {
    result.compat_warnings = ignored.map((field) => ({
      code: "argument_ignored",
      field,
      detail: "v3's Thor/Stormforge profile and artifact arguments are not carried (V3-PARITY.md §4.3)",
    }));
  }
  return result;
}
