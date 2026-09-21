import { type JcsObject } from "../contracts/jcs";
import { type RevisionResult } from "../contracts/revision-v1";
import { parseInt64Text, timestampToMicros } from "./rows";
import { type BuiltRevision } from "./service.types";
import { writableTimestamp } from "./service.writableTimestamp";

export function buildRevisionRow(
  validated: RevisionResult,
  envelope: JcsObject,
  allocation: {
    revisionId: string;
    workspace: string;
    nodeId: string;
    operationId: string;
    revisionNo: bigint;
    baseRevisionId: string | null;
    createdAt: string;
  },
): BuiltRevision {
  // Normalized JSON columns come from the codec; scalar envelope fields come
  // from the validated content map. Never the raw request strings.
  const c = validated.columns as unknown as Record<string, unknown>;
  const e = (key: string): unknown => envelope.get(key) ?? null;
  const micros = timestampToMicros(allocation.createdAt);
  const physical: Record<string, unknown> = {
    id: allocation.revisionId,
    workspace_name: allocation.workspace,
    node_id: allocation.nodeId,
    revision_no: allocation.revisionNo,
    base_revision_id: allocation.baseRevisionId,
    operation_id: allocation.operationId,
    title: e("title"),
    body: e("body"),
    body_format: e("body_format"),
    fields: c.fields,
    author_peer_name: e("author_peer_name"),
    observer_peer_name: e("observer_peer_name"),
    subject_peer_name: e("subject_peer_name"),
    session_name: e("session_name"),
    is_active: e("is_active"),
    // Raw microsecond BigInts, never Date: a Date round trip would drop
    // precision the timestamp[us] column can hold, and the read path
    // deliberately refuses Date for exactly that reason.
    valid_from: e("valid_from") === null ? null : writableTimestamp(e("valid_from") as string),
    valid_to: e("valid_to") === null ? null : writableTimestamp(e("valid_to") as string),
    change_reason: e("change_reason"),
    created_at: micros,
    schema_version: typeof e("schema_version") === "string" ? parseInt64Text(e("schema_version")) : 1n,
    canonical_version: (e("canonical_version") as string | null) ?? "arra-revision/v1",
    content_digest: validated.content_digest,
    term_snapshot_json: c.term_snapshot_json,
    link_snapshot_json: c.link_snapshot_json,
    h_metadata: c.h_metadata ?? null,
    internal_metadata: c.internal_metadata ?? null,
  };

  // The expected wire form, from the SAME values -- not a re-encode of the
  // physical row, whose Dates the read decoder deliberately refuses.
  const wire: Record<string, unknown> = {
    ...physical,
    revision_no: allocation.revisionNo.toString(10),
    schema_version: (physical.schema_version as bigint).toString(10),
    created_at: allocation.createdAt,
    valid_from: e("valid_from") === null ? null : (e("valid_from") as string),
    valid_to: e("valid_to") === null ? null : (e("valid_to") as string),
  };

  return { physical, wire };
}
