import { requireExactColumns } from "./search-chunk.requireExactColumns";
import { storedEmbedding } from "./search-chunk.storedEmbedding";
import { storedInt64Text } from "./search-chunk.storedInt64Text";
import { storedNullableText } from "./search-chunk.storedNullableText";
import { storedNullableTimestamp } from "./search-chunk.storedNullableTimestamp";
import { storedStatus } from "./search-chunk.storedStatus";
import { storedTermIds } from "./search-chunk.storedTermIds";
import { storedText } from "./search-chunk.storedText";

/** The exact physical field order of a stored search-chunk row. */
export const SEARCH_CHUNK_FIELDS = [
  "id",
  "workspace_name",
  "node_id",
  "revision_id",
  "chunk_index",
  "text",
  "content_hash",
  "chunker_version",
  "embedding_profile",
  "embedding",
  "type_term_id",
  "term_ids",
  "observer_peer_name",
  "subject_peer_name",
  "session_name",
  "status",
  "attempts",
  "last_attempt_at",
  "embedded_at",
  "error_code",
] as const;

/**
 * One stored row to its wire fields, in physical order minus `embedding`.
 *
 * `embedding` is DELIBERATELY OMITTED from the returned object rather than
 * emitted as `null` or as a 384-float array: the instruction is "omitted or
 * null on the wire", and omission is the cheaper, unambiguous choice -- a
 * caller checking `"embedding" in row` gets a real answer instead of one that
 * depends on which sender it saw. This holds whether the stored value is
 * null or populated -- #90 gave this writer a real path to a populated
 * vector, but did not change what this wire codec exposes.
 */
export function encodeSearchChunkRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, SEARCH_CHUNK_FIELDS);
  // Validated for shape even though it is not emitted: a corrupt embedding
  // column -- null or populated -- is still stored corruption, whether or
  // not the wire ever shows it.
  storedEmbedding(row.embedding);
  return {
    id: storedText(row.id),
    workspace_name: storedText(row.workspace_name),
    node_id: storedText(row.node_id),
    revision_id: storedText(row.revision_id),
    chunk_index: storedInt64Text(row.chunk_index),
    text: storedText(row.text),
    content_hash: storedText(row.content_hash),
    chunker_version: storedText(row.chunker_version),
    embedding_profile: storedText(row.embedding_profile),
    type_term_id: storedText(row.type_term_id),
    term_ids: storedTermIds(row.term_ids),
    observer_peer_name: storedNullableText(row.observer_peer_name),
    subject_peer_name: storedNullableText(row.subject_peer_name),
    session_name: storedNullableText(row.session_name),
    status: storedStatus(row.status),
    attempts: storedInt64Text(row.attempts),
    last_attempt_at: storedNullableTimestamp(row.last_attempt_at),
    embedded_at: storedNullableTimestamp(row.embedded_at),
    error_code: storedNullableText(row.error_code),
  };
}
