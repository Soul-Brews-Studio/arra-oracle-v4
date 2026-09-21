import { fail } from "../errors";
import type { JcsObject } from "../jcs";
import {
  requireClosedObject,
  requireNanoid21,
  requireNonemptyString,
  requireSha256Hex,
  requireTimestampString,
  requireUnicodeString,
} from "../common";
import { messageDigest } from "../v1";
import { get } from "./get";
import { parseRoot } from "./parse-root";
import { requireNullable } from "./require-nullable";

const CONTEXT_KEYS = ["workspace_name", "session_name", "intake_at", "source_namespace"] as const;
const MESSAGE_KEYS = ["peer_name", "role", "content", "in_reply_to"] as const;
const SOURCE_KEYS = ["source_message_id", "source_created_at", "supplied_digest"] as const;

// ---------------------------------------------------------------------------
// 8.1 prepareNewMessage
// ---------------------------------------------------------------------------

export function prepareNewMessage(json: unknown): Record<string, unknown> {
  const root = requireClosedObject(parseRoot(json), ["context", "message", "source"], []);

  // ---- structural and value validation of the WHOLE input, in listed order ----
  const context = requireClosedObject(get(root, "context"), CONTEXT_KEYS, ["context"]);
  const workspace_name = requireNonemptyString(get(context, "workspace_name"), ["context", "workspace_name"]);
  const session_name = requireNonemptyString(get(context, "session_name"), ["context", "session_name"]);
  const intake_at = requireTimestampString(get(context, "intake_at"), ["context", "intake_at"]);
  const configuredNamespace = requireNullable(get(context, "source_namespace"), ["context", "source_namespace"], requireNonemptyString);

  // The untrusted halves are closed WITHOUT a namespace key, so an attempt to
  // supply one is `unexpected_field` rather than a value this code must decide
  // whether to trust. Configuration injects the namespace; there is no
  // competing caller value to compare or overwrite.
  const message = requireClosedObject(get(root, "message"), MESSAGE_KEYS, ["message"]);
  const peer_name = requireNonemptyString(get(message, "peer_name"), ["message", "peer_name"]);
  const role = requireNullable(get(message, "role"), ["message", "role"], requireUnicodeString);
  const content = requireUnicodeString(get(message, "content"), ["message", "content"]);
  const in_reply_to = requireNullable(get(message, "in_reply_to"), ["message", "in_reply_to"], requireNanoid21);

  const rawSource = get(root, "source");
  let source: JcsObject | null = null;
  let source_message_id: string | null = null;
  let source_created_at: string | null = null;
  let supplied_digest: string | null = null;
  if (rawSource !== null) {
    source = requireClosedObject(rawSource, SOURCE_KEYS, ["source"]);
    source_message_id = requireNonemptyString(get(source, "source_message_id"), ["source", "source_message_id"]);
    source_created_at = requireNullable(get(source, "source_created_at"), ["source", "source_created_at"], requireTimestampString);
    supplied_digest = requireNullable(get(source, "supplied_digest"), ["source", "supplied_digest"], requireSha256Hex);
  }

  // ---- semantic relationships, after the whole shape is known ----
  // Mode and configuration must agree BEFORE any digest comparison.
  if (source === null && configuredNamespace !== null) {
    fail("invalid_value", ["context", "source_namespace"], "local mode requires a null configured namespace");
  }
  if (source !== null && configuredNamespace === null) {
    fail("invalid_value", ["context", "source_namespace"], "sourced mode requires a configured namespace");
  }

  let source_payload_digest: string | null = null;
  if (source !== null) {
    // Recomputed from the accepted envelope by this trusted boundary. A supplied
    // digest is verification input, never authority.
    source_payload_digest = messageDigest({
      source_namespace: configuredNamespace,
      source_message_id,
      peer_name,
      role,
      content,
      source_created_at,
      in_reply_to,
    });
    if (supplied_digest !== null && supplied_digest !== source_payload_digest) {
      fail("digest_mismatch", ["source", "supplied_digest"], "supplied digest does not match the recomputed envelope digest");
    }
  }

  return {
    workspace_name,
    session_name,
    peer_name,
    role,
    content,
    in_reply_to,
    source_namespace: configuredNamespace,
    source_message_id,
    source_payload_digest,
    source_created_at,
    // Compatibility ordering column; SEQUENCE, not this, orders a conversation.
    created_at: source_created_at ?? intake_at,
    // Service-selected intake, injected by the caller. Never a clock read here.
    ingested_at: intake_at,
  };
}
