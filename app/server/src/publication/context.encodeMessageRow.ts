import { prepareNewMessage, validateStoredSourceState } from "../contracts/source-ingestion-v1";
import { failPublication } from "./errors";
import { ordered } from "./context.ordered";
import { storedContent } from "./context.storedContent";
import { storedId } from "./context.storedId";
import { storedInt64 } from "./context.storedInt64";
import { storedName } from "./context.storedName";
import { storedNullableBoolean } from "./context.storedNullableBoolean";
import { storedNullableText } from "./context.storedNullableText";
import { storedNullableTimestamp } from "./context.storedNullableTimestamp";
import { storedTimestamp } from "./context.storedTimestamp";

export const MESSAGE_FIELDS = [
  "id", "public_id", "workspace_name", "session_name", "peer_name", "content", "token_count",
  "seq_in_session", "h_metadata", "internal_metadata", "created_at", "role", "in_reply_to",
  "read", "read_at", "source_namespace", "source_message_id", "source_payload_digest",
  "source_created_at", "ingested_at",
] as const;

export function encodeMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  const content = storedContent(row.content);
  const createdAt = storedTimestamp(row.created_at);
  const ingestedAt = storedTimestamp(row.ingested_at);
  const sourceCreatedAt = storedNullableTimestamp(row.source_created_at);

  // SHAPE of the stored source state, through the ACCEPTED validator rather
  // than a hand-rolled all-or-none check.
  let stored: Record<string, unknown>;
  try {
    stored = validateStoredSourceState(JSON.stringify({
      source_namespace: row.source_namespace ?? null,
      source_message_id: row.source_message_id ?? null,
      source_payload_digest: row.source_payload_digest ?? null,
      source_created_at: sourceCreatedAt,
      ingested_at: ingestedAt,
    }));
  } catch {
    return failPublication("integrity_failure");
  }
  const namespace = stored.source_namespace as string | null;
  const sourceId = stored.source_message_id as string | null;
  const digest = stored.source_payload_digest as string | null;

  if (namespace !== null) {
    // RECOMPUTE, do not merely shape-check. A lowercase-hex 64 is a shape; it
    // says nothing about the content it claims to cover, so a tampered row
    // carrying its ORIGINAL digest would otherwise read back as healthy.
    //
    // The accepted boundary is prepareNewMessage: it is the only place that
    // holds the message envelope, and validateStoredSourceState says so in
    // its own words. Passing the stored digest as `supplied_digest` makes the
    // codec compare recomputed against stored for us -- no second digest
    // implementation lives here.
    try {
      prepareNewMessage(JSON.stringify({
        context: {
          workspace_name: row.workspace_name ?? null,
          session_name: row.session_name ?? null,
          intake_at: ingestedAt,
          source_namespace: namespace,
        },
        message: {
          peer_name: row.peer_name ?? null,
          role: row.role ?? null,
          content,
          in_reply_to: row.in_reply_to ?? null,
        },
        source: {
          source_message_id: sourceId,
          source_created_at: sourceCreatedAt,
          supplied_digest: digest,
        },
      }));
    } catch {
      // Any failure here is STORED-state corruption, at the root path: the
      // caller sent nothing wrong.
      return failPublication("integrity_failure");
    }
  }

  return ordered({
    id: storedInt64(row.id),
    public_id: storedId(row.public_id),
    workspace_name: storedName(row.workspace_name),
    session_name: storedName(row.session_name),
    peer_name: storedName(row.peer_name),
    content,
    // Negative token_count is corruption, not a value to carry forward.
    token_count: storedInt64(row.token_count, { min: 0n }),
    seq_in_session: storedInt64(row.seq_in_session),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    created_at: createdAt,
    role: storedNullableText(row.role),
    // A reply target is an identifier, so it carries the identifier grammar.
    in_reply_to: row.in_reply_to === null || row.in_reply_to === undefined ? null : storedId(row.in_reply_to),
    read: storedNullableBoolean(row.read),
    read_at: storedNullableTimestamp(row.read_at),
    source_namespace: namespace,
    source_message_id: sourceId,
    source_payload_digest: digest,
    source_created_at: sourceCreatedAt,
    ingested_at: ingestedAt,
  }, MESSAGE_FIELDS);
}
