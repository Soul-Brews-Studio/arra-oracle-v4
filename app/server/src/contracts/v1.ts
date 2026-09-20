/** Candidate #23 codecs. Not wired into legacy endpoints or live migrations. */
import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

export function validateId(value: unknown): string {
  if (typeof value !== "string" || value.length !== 21 || !/^[A-Za-z0-9_-]{21}$/.test(value)) {
    throw new Error("id must be 21 URL-safe ASCII characters");
  }
  return value;
}

export function newId(): string {
  // Alphabet size 64 divides 256, so masking introduces no modulo bias.
  return Array.from(randomBytes(21), (byte) => ALPHABET[byte & 63]).join("");
}

export function parseInt64(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 20 || value !== value.trim() || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    throw new Error("int64 requires canonical decimal text");
  }
  const result = BigInt(value);
  if (result < MIN_I64 || result > MAX_I64) throw new Error("int64 out of range");
  return result;
}

export function formatInt64(value: bigint): string {
  if (typeof value !== "bigint") throw new Error("int64 requires bigint internally");
  return parseInt64(value.toString()).toString();
}

export function parseTimestamp(value: unknown): Date {
  if (typeof value !== "string" || value.length !== 24 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value) || value.startsWith("0000")) {
    throw new Error("timestamp requires UTC YYYY-MM-DDTHH:mm:ss.SSSZ, years 1..9999");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("invalid calendar timestamp");
  }
  return parsed;
}

export function formatTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid Date");
  const result = value.toISOString();
  parseTimestamp(result);
  return result;
}

const MESSAGE_FIELDS = ["source_namespace", "source_message_id", "peer_name", "role", "content", "source_created_at", "in_reply_to"] as const;

function unicodeString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  // Iteration combines valid surrogate pairs but leaves lone surrogates visible.
  for (const character of value) {
    const cp = character.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error("unpaired Unicode surrogate");
  }
  return value;
}

export function canonicalMessage(value: unknown): Uint8Array {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected message object");
  const input = value as Record<string, unknown>;
  if (Reflect.ownKeys(input).length !== MESSAGE_FIELDS.length || !MESSAGE_FIELDS.every((key) => Object.hasOwn(input, key))) {
    throw new Error("message must contain exactly the versioned fields, including explicit nulls");
  }
  const ordered: Record<string, string | null> = {};
  for (const key of MESSAGE_FIELDS) {
    const field = input[key];
    const nullable = key === "role" || key === "source_created_at" || key === "in_reply_to";
    if (nullable && field === null) {
      ordered[key] = null;
      continue;
    }
    const text = unicodeString(field);
    if ((key === "source_namespace" || key === "source_message_id" || key === "peer_name") && text.length === 0) {
      throw new Error(`${key} must not be empty`);
    }
    if (key === "source_created_at") parseTimestamp(text);
    ordered[key] = text;
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export function messageDigest(value: unknown): string {
  return createHash("sha256").update("arra-message/v1\n", "utf8").update(canonicalMessage(value)).digest("hex");
}
