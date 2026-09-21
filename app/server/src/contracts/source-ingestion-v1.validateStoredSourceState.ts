import { fail } from "../errors";
import { requireClosedObject, requireNonemptyString, requireSha256Hex, requireTimestampString } from "../common";
import { get } from "./get";
import { parseRoot } from "./parse-root";
import { requireNullable } from "./require-nullable";

const STORED_KEYS = ["source_namespace", "source_message_id", "source_payload_digest", "source_created_at", "ingested_at"] as const;

// ---------------------------------------------------------------------------
// 8.2 validateStoredSourceState
// ---------------------------------------------------------------------------

export function validateStoredSourceState(json: unknown): Record<string, unknown> {
  const o = requireClosedObject(parseRoot(json), STORED_KEYS, []);
  const source_namespace = requireNullable(get(o, "source_namespace"), ["source_namespace"], requireNonemptyString);
  const source_message_id = requireNullable(get(o, "source_message_id"), ["source_message_id"], requireNonemptyString);
  // SHAPE ONLY: this input carries no message envelope, so nothing here can
  // recompute the digest. A full sourced record is validated through
  // prepareNewMessage, where the content exists.
  const source_payload_digest = requireNullable(get(o, "source_payload_digest"), ["source_payload_digest"], requireSha256Hex);
  const source_created_at = requireNullable(get(o, "source_created_at"), ["source_created_at"], requireTimestampString);
  const ingested_at = requireTimestampString(get(o, "ingested_at"), ["ingested_at"]);

  // §3 presence predicate. Nullable Arrow columns cannot express this.
  const present = [source_namespace, source_message_id, source_payload_digest].filter((v) => v !== null).length;
  if (present !== 0 && present !== 3) {
    fail("invalid_value", ["source_namespace"], "source triple must be wholly present or wholly absent");
  }
  if (present === 0 && source_created_at !== null) {
    fail("invalid_value", ["source_created_at"], "source time requires the source triple");
  }

  return { source_namespace, source_message_id, source_payload_digest, source_created_at, ingested_at };
}
