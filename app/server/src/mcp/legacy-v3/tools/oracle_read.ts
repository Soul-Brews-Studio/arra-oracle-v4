import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { resolveNodeId } from "../ids.resolveNodeId";
import { readTermSnapshot } from "../readTermSnapshot";

/** `getAcceptedHead`'s wire shape (`publication/service.getAcceptedHead.ts`),
 *  named locally rather than imported: A1 forbids this layer importing
 *  anything from `publication/*`. */
type LifecycleLabel = { kind: "retired" | "superseded"; new_id: string | null; reason: string; superseded_at: string } | null;
type AcceptedHead = { node: Record<string, unknown>; revision: Record<string, unknown>; lifecycle: LifecycleLabel };

const NO_FILE_DETAIL = "v4 has no server file; the content lives in LanceDB, read by id";

/**
 * `oracle_read` (V3-PARITY.md §4.2 slice V2; v3 src/tools/read.ts:196-238).
 *
 * A browse path (A6): a superseded or retired node is still read, flagged
 * with `superseded_by`/`superseded_at`/`superseded_reason` taken from the
 * `lifecycle` label `getAcceptedHead` already carries (#29 slice B) -- no
 * separate `listLifecycleHistory` call is needed for a node's OWN single
 * terminal event, since a node can carry at most one (`writeLifecycleEventFresh`'s
 * append-only rule) and `getAcceptedHead`'s label is exactly that row.
 *
 * `file` is not carried (v4 does no server file reads); its absence AND the
 * absence of `id` both refuse before any kb call.
 */
export async function oracle_read(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  if (typeof args.file === "string" && args.file.trim() !== "") {
    throw new CompatError(context.tool, "not_carried", "file is not carried in v4", "v4 does no server file reads; LanceDB is canonical. Pass id instead.", { path: "/file" });
  }
  if (typeof args.id !== "string" || args.id.trim() === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /id: id is required (file is not carried)", "oracle_read needs an id", { path: "/id" });
  }

  const resolved = await resolveNodeId(context.kb, context.bank, args.id, context.tool);
  if (resolved === null) {
    throw new CompatError(context.tool, "no_results", `Document not found: ${args.id}`, "no node exists with this id in this bank", { path: "/id" });
  }
  const head = resolved.head as AcceptedHead;
  const project = readTermSnapshot(head.revision.term_snapshot_json, "project");
  const lifecycle = head.lifecycle;

  return {
    content: head.revision.body,
    title: head.revision.title,
    source_file: null,
    resolved_path: null,
    source: "node",
    ...(project === null ? {} : { project }),
    ...(lifecycle === null
      ? {}
      : {
          superseded_by: lifecycle.new_id,
          superseded_at: lifecycle.superseded_at,
          superseded_reason: lifecycle.reason,
        }),
    compat_warnings: [
      { code: "field_unavailable", field: "source_file", detail: NO_FILE_DETAIL },
      { code: "field_unavailable", field: "resolved_path", detail: NO_FILE_DETAIL },
    ],
    v4: { node_id: resolved.node_id, revision_id: head.revision.id, revision_no: head.revision.revision_no },
  };
}
