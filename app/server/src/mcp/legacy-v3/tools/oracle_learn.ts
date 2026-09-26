import { cleanNames } from "../cleanNames";
import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { normalizeProject } from "../normalizeProject";
import { publish } from "../publish";
import { titleOf } from "../titleOf";

/**
 * `oracle_learn` (V3-PARITY.md §4.3; v3 src/tools/learn.ts:48-74, output
 * :307-318). A learning node: type `learning`, the concepts, one project
 * (`_universal` when none), body = pattern, title = its first line. No file
 * is written, so `file` is null and named in compat_warnings (§2.5).
 */
export async function oracle_learn(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  if (typeof args.pattern !== "string" || args.pattern.trim() === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /pattern: pattern is required", "v3's own rule: a nonblank pattern", { path: "/pattern" });
  }
  const author = await ensureSpeaker(context, args);
  const source = typeof args.source === "string" && args.source.trim() !== "" ? args.source : undefined;
  const done = await publish(context, {
    title: titleOf(args.pattern),
    body: args.pattern,
    fields: source === undefined ? {} : { source },
    terms: { type: "learning", concepts: cleanNames(args.concepts), project: normalizeProject(args.project) },
    links: [],
    author,
    sessionName: null,
    changeReason: null,
    idempotencyKey: args.idempotency_key,
  });
  return {
    success: true,
    file: null,
    id: done.node_id,
    embedding: done.embedding,
    ...(done.embeddingError === undefined ? {} : { embeddingError: done.embeddingError }),
    message: `Learning saved as v4 node ${done.node_id}${done.outcome === "idempotent" ? " (replayed)" : ""}`,
    compat_warnings: [
      { code: "field_unavailable", field: "file", detail: "v4 writes no file; the learning is a node in LanceDB" },
      ...(done.associationsError === undefined
        ? []
        : [{ code: "partial", field: "concepts", detail: `this entry's term associations did not reconcile (${done.associationsError}); oracle_concepts/oracle_stats may undercount it until a retry succeeds` }]),
    ],
    // `associationsError` has no v3 precedent (unlike `embeddingError`,
    // which mirrors v3's own field): a pure v4 addition, so it lives inside
    // `v4`, the "carrying native ids" extension point (V3-PARITY.md §2.5),
    // not as a bare new top-level key.
    v4: { node_id: done.node_id, revision_id: done.revision_id, ...(done.associationsError === undefined ? {} : { associationsError: done.associationsError }) },
  };
}
