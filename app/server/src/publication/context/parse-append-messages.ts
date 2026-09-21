import {
  requireBoundedText,
  requireClosedObject,
  requireNanoid21,
  requireNonemptyString,
  requireNullableString,
  requireNullableTimestampString,
  requireSha256Hex,
  requireUnicodeString,
  type Tokens,
} from "../../contracts/common";
import { fail } from "../../contracts/errors";
import { MAX_NAME_BYTES } from "./constants";
import { name } from "./name";
import { nanoid } from "./nanoid";
import { parseRequest } from "./parse-request";

/** Items per batch. Nonempty, and no more than this. */
export const MAX_ITEMS = 128;

const MESSAGE_KEYS = ["peer_name", "role", "content", "in_reply_to"] as const;
const SOURCE_KEYS = ["source_message_id", "source_created_at", "supplied_digest"] as const;
const ITEM_KEYS = ["public_id", "message", "source"] as const;

export type AppendItem = {
  public_id: string;
  message: Record<string, unknown>;
  source: Record<string, unknown> | null;
};
export type AppendMessagesRequest = {
  workspace_name: string;
  session_name: string;
  items: AppendItem[];
};

export function parseAppendMessages(bytes: Uint8Array): AppendMessagesRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_name", "items"], []);
  const rawItems = o.get("items");
  if (!Array.isArray(rawItems)) fail("invalid_type", ["items"], "expected array");
  if (rawItems.length === 0) fail("invalid_value", ["items"], "must be nonempty");
  if (rawItems.length > MAX_ITEMS) {
    fail("limit_exceeded", ["items"], `at most ${MAX_ITEMS} items`);
  }

  const items: AppendItem[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawItems.entries()) {
    const at = (...rest: Array<string | number>): Tokens => ["items", index, ...rest];
    const entry = requireClosedObject(raw, ITEM_KEYS, ["items", index]);
    const publicId = nanoid(entry.get("public_id"), at("public_id"));
    // The LATER occurrence is the one that collides with what came before.
    if (seen.has(publicId)) fail("invalid_value", at("public_id"), "duplicate public_id");
    seen.add(publicId);

    // TYPE and FORMAT of the whole input are settled HERE, before admission.
    // A malformed later item must refuse the request before any earlier row is
    // written -- otherwise a durable prefix is created for input that was never
    // well formed. Only source MODE agreement, supplied-digest EQUALITY and
    // foreign references stay per-item, because those are semantics rather
    // than shape.
    //
    // Every check below is a governed helper, not a second parser: the field
    // grammars, RFC 6901 escaping and error envelope all come from the shared
    // codec.
    const message = requireClosedObject(entry.get("message") ?? null, MESSAGE_KEYS, at("message"));
    requireBoundedText(
      requireNonemptyString(message.get("peer_name") ?? null, at("message", "peer_name")),
      MAX_NAME_BYTES,
      at("message", "peer_name"),
    );
    requireNullableString(message.get("role") ?? null, at("message", "role"));
    // Content may be EMPTY -- that is prepareNewMessage's accepted grammar, and
    // tightening it here would reject input the codec allows.
    requireUnicodeString(message.get("content") ?? null, at("message", "content"));
    const replyTo = message.get("in_reply_to") ?? null;
    if (replyTo !== null) requireNanoid21(replyTo, at("message", "in_reply_to"));

    const rawSource = entry.get("source");
    const source =
      rawSource === null ? null : requireClosedObject(rawSource ?? null, SOURCE_KEYS, at("source"));
    if (source !== null) {
      requireNonemptyString(source.get("source_message_id") ?? null, at("source", "source_message_id"));
      requireNullableTimestampString(source.get("source_created_at") ?? null, at("source", "source_created_at"));
      const supplied = source.get("supplied_digest") ?? null;
      // Format only. Whether it MATCHES the recomputed envelope digest is
      // per-item semantics and stays with prepareNewMessage.
      if (supplied !== null) requireSha256Hex(supplied, at("source", "supplied_digest"));
    }

    items.push({
      public_id: publicId,
      message: Object.fromEntries(message) as Record<string, unknown>,
      source: source === null ? null : (Object.fromEntries(source) as Record<string, unknown>),
    });
  }

  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    items,
  };
}
