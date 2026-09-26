import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { normalizeProject } from "../normalizeProject";
import { publish } from "../publish";
import { titleOf } from "../titleOf";

/**
 * `oracle_handoff` (V3-PARITY.md §4.3; v3 src/tools/handoff.ts:21-38,91-139).
 * A `note` tagged `concepts:handoff` and `memory_horizon:short_term` -- a tag,
 * never a type, because `type` is sealed and reserved (R6). The title is the
 * slug, else the first heading or line. Every call is a new node, so v3's
 * same-minute overwrite, traversable slug and unread write directory are gone.
 * Indexed like a learning, so reconcile never reports it missing.
 */
export async function oracle_handoff(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  if (typeof args.content !== "string" || args.content.trim() === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /content: content is required", "v3's own rule: nonblank content", { path: "/content" });
  }
  const slug = typeof args.slug === "string" && args.slug.trim() !== "" ? titleOf(args.slug) : undefined;
  const session = typeof args.session === "string" && args.session !== "" ? args.session : null;
  const author = await ensureSpeaker(context, args);
  const done = await publish(context, {
    title: slug ?? titleOf(args.content),
    body: args.content,
    fields: {},
    terms: { type: "note", horizon: "short_term", concepts: ["handoff"], project: normalizeProject(args.project) },
    links: [],
    author,
    sessionName: session,
    changeReason: null,
    idempotencyKey: args.idempotency_key,
  });
  return {
    success: true,
    file: null,
    id: done.node_id,
    message: `Handoff saved as v4 node ${done.node_id}`,
    compat_warnings: [
      { code: "field_unavailable", field: "file", detail: "v4 writes no inbox file; the handoff is a node in LanceDB" },
      ...(done.associationsError === undefined
        ? []
        : [{ code: "partial", field: "concepts", detail: `this entry's term associations did not reconcile (${done.associationsError}); oracle_concepts/oracle_stats may undercount it until a retry succeeds` }]),
    ],
    v4: { node_id: done.node_id, revision_id: done.revision_id, embedding: done.embedding },
  };
}
