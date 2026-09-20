/**
 * Source ingestion and legacy boundary — candidate v1. PURE.
 *
 * Four raw-JSON-in, JSON-out validators for the message ingestion boundary.
 * They allocate no ID or sequence, read no clock, open no database, call no
 * model, and introduce no canonicalization of their own: the digest comes from
 * the ALREADY ACCEPTED `messageDigest` over its unchanged seven-field
 * `arra-message/v1` envelope, and replay classification comes from the
 * unchanged `sourceReplayOp`.
 *
 * Input is a raw JSON STRING on purpose. Duplicate decoded keys, invalid
 * Unicode, and size/depth limits are caught by the existing strict parser
 * before anything becomes a native object — a validator that accepted an
 * already-parsed object could not see any of those. It also keeps this module
 * distinguishable from the future authorized service that CONSTRUCTS that
 * input after authorization.
 *
 * What this module does NOT prove: authorization, durable ingestion, service
 * uniqueness, sequence allocation, writer exclusion, or dataset-wide collision
 * detection. Those are #25/#28/#34 gates.
 *
 * Contract: app/docs/contracts/source-ingestion-v1.md §8–§10.
 */

import { ContractError, fail } from "./errors";
import { LIMITS, type JcsObject, type JcsValue, parseStrict } from "./jcs";
import {
  requireClosedObject,
  requireNanoid21,
  requireNonemptyString,
  requireSha256Hex,
  requireTimestampString,
  requireUnicodeString,
  type Tokens,
} from "./common";
import { messageDigest, formatTimestamp } from "./v1";
import { sourceReplayOp } from "./replay-v1";

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT64_SYNTAX = /^(?:0|-?[1-9][0-9]*)$/;

/**
 * Local Int64 validator. `requireInt64String` (common.ts, shared and
 * unchanged) folds malformed syntax AND out-of-range magnitude into one
 * `invalid_value` for its existing callers. Section9's table requires the
 * split: a syntactically canonical decimal string that is simply too large
 * or too small is `out_of_range`, not `invalid_value`. Only genuinely
 * malformed spelling -- leading zeros, a sign on zero, whitespace, non-digit
 * characters, or a string too long to be a plausible int64 -- is
 * `invalid_value`. Mirrors the shared length/regex rule so a boundary value
 * like the exact INT64_MIN literal is not misclassified by an over-eager
 * length cutoff.
 */
function requireInt64Ranged(value: JcsValue, tokens: Tokens): { text: string; value: bigint } {
  if (typeof value !== "string") fail("invalid_type", tokens, "int64 must be a canonical decimal string");
  // Canonical SYNTAX first, independent of length: leading zero, a sign on
  // zero, non-digit characters, or surrounding whitespace is invalid_value
  // regardless of how long the malformed text is.
  if (value !== value.trim() || !INT64_SYNTAX.test(value)) {
    fail("invalid_value", tokens, "int64 requires canonical decimal text");
  }
  // The text is canonically formed. A canonical decimal LONGER than 20
  // characters is GUARANTEED to exceed the signed 64-bit range -- the longest
  // valid boundary, MIN_I64 = "-9223372036854775808", is exactly 20 characters
  // including its sign -- so this is out_of_range WITHOUT ever constructing a
  // BigInt from an arbitrarily long digit string.
  if (value.length > 20) {
    fail("out_of_range", tokens, "int64 is outside the signed 64-bit range");
  }
  const parsed = BigInt(value);
  if (parsed < INT64_MIN || parsed > INT64_MAX) {
    fail("out_of_range", tokens, "int64 is outside the signed 64-bit range");
  }
  return { text: value, value: parsed };
}

/** Microsecond bounds of the supported Gregorian range, 0001-01-01 .. 9999-12-31T23:59:59.999Z. */
const MIN_SUPPORTED_US = -62135596800000n * 1000n;
const MAX_SUPPORTED_US = 253402300799999n * 1000n;

/** Parse one bounded root document with the accepted strict rules. */
function parseRoot(json: unknown): JcsValue {
  if (typeof json !== "string") fail("invalid_type", [], "expected a raw JSON string");
  return parseStrict(json, [], { maxBytes: LIMITS.maxDocumentBytes, maxDepth: LIMITS.maxDepth });
}

const get = (o: JcsObject, key: string): JcsValue => o.get(key) as JcsValue;

function requireNullable<T>(value: JcsValue, tokens: Tokens, read: (v: JcsValue, t: Tokens) => T): T | null {
  return value === null ? null : read(value, tokens);
}

// ---------------------------------------------------------------------------
// 8.1 prepareNewMessage
// ---------------------------------------------------------------------------

const CONTEXT_KEYS = ["workspace_name", "session_name", "intake_at", "source_namespace"] as const;
const MESSAGE_KEYS = ["peer_name", "role", "content", "in_reply_to"] as const;
const SOURCE_KEYS = ["source_message_id", "source_created_at", "supplied_digest"] as const;

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

// ---------------------------------------------------------------------------
// 8.2 validateStoredSourceState
// ---------------------------------------------------------------------------

const STORED_KEYS = ["source_namespace", "source_message_id", "source_payload_digest", "source_created_at", "ingested_at"] as const;

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

// ---------------------------------------------------------------------------
// 8.3 mapLegacyMessageBoundary
// ---------------------------------------------------------------------------

const LEGACY_CONTEXT_KEYS = ["workspace_name", "session_name", "migration_intake_at"] as const;
const LEGACY_KEYS = [
  "id", "public_id", "seq_in_session", "created_at_us",
  "source_namespace", "source_message_id", "source_payload_digest", "source_created_at",
] as const;
const LEGACY_SOURCE_FIELDS = ["source_namespace", "source_message_id", "source_payload_digest", "source_created_at"] as const;

const LEGACY_INTAKE_ASSUMPTION = "ingested_at=migration_intake;original_ingestion_unknown";

export function mapLegacyMessageBoundary(json: unknown): Record<string, unknown> {
  const root = requireClosedObject(parseRoot(json), ["context", "legacy"], []);

  const context = requireClosedObject(get(root, "context"), LEGACY_CONTEXT_KEYS, ["context"]);
  const workspace_name = requireNonemptyString(get(context, "workspace_name"), ["context", "workspace_name"]);
  const session_name = requireNonemptyString(get(context, "session_name"), ["context", "session_name"]);
  const migration_intake_at = requireTimestampString(get(context, "migration_intake_at"), ["context", "migration_intake_at"]);

  const legacy = requireClosedObject(get(root, "legacy"), LEGACY_KEYS, ["legacy"]);
  // Signed Int64 as-is: no positivity rule is invented for retained handles.
  const id = requireInt64Ranged(get(legacy, "id"), ["legacy", "id"]).text;
  const public_id = requireNanoid21(get(legacy, "public_id"), ["legacy", "public_id"]);
  const seq_in_session = requireInt64Ranged(get(legacy, "seq_in_session"), ["legacy", "seq_in_session"]).text;
  const micros = requireInt64Ranged(get(legacy, "created_at_us"), ["legacy", "created_at_us"]);
  // ---- semantics: source-less status BEFORE physical-time precision ----
  // ANY non-null value in these fields is invalid_value, whatever its type --
  // a number, boolean, array or object is just as much "not source-less" as a
  // string. First such field in listed order is reported.
  for (const field of LEGACY_SOURCE_FIELDS) {
    if (get(legacy, field) !== null) {
      fail("invalid_value", ["legacy", field], "this boundary maps source-less legacy rows only; a sourced row is held for #34");
    }
  }

  // Raw exported microseconds, checked BEFORE any JS Date conversion: the
  // accessor path that would round them is exactly what this guards against.
  if (micros.value % 1000n !== 0n) {
    fail("out_of_range", ["legacy", "created_at_us"], `stored ${micros.text}us is not millisecond-exact; refusing to round`);
  }
  if (micros.value < MIN_SUPPORTED_US || micros.value > MAX_SUPPORTED_US) {
    fail("out_of_range", ["legacy", "created_at_us"], `stored ${micros.text}us is outside Gregorian years 0001-9999`);
  }
  const created_at = formatTimestamp(new Date(Number(micros.value / 1000n)));

  return {
    workspace_name,
    session_name,
    id,
    public_id,
    seq_in_session,
    created_at,
    // The FROZEN migration intake. Never created_at, which would assert an
    // unobserved historical ingestion time; never a clock, so a retry maps
    // identically.
    ingested_at: migration_intake_at,
    source_namespace: null,
    source_message_id: null,
    source_payload_digest: null,
    source_created_at: null,
    // A returned report field, not a new database column.
    assumptions: [LEGACY_INTAKE_ASSUMPTION],
  };
}

// ---------------------------------------------------------------------------
// 8.4 classifyMessageDestinationReplay
// ---------------------------------------------------------------------------

const REQUESTED_KEYS = ["workspace_name", "session_name"] as const;
const INCOMING_KEYS = ["source_namespace", "source_message_id", "source_payload_digest"] as const;
const EXISTING_KEYS = ["workspace_name", "session_name", "source_namespace", "source_message_id", "source_payload_digest", "public_id"] as const;

/** Helper field names differ from ours; translate paths back so callers never see them. */
const HELPER_PATH_RENAMES: Array<[RegExp, string]> = [
  [/\/content_digest$/, "/source_payload_digest"],
  [/\/message_public_id$/, "/public_id"],
];

export function classifyMessageDestinationReplay(json: unknown): { outcome: string; original_id: string | null } {
  const root = requireClosedObject(parseRoot(json), ["requested", "incoming", "existing"], []);

  const requested = requireClosedObject(get(root, "requested"), REQUESTED_KEYS, ["requested"]);
  const reqWorkspace = requireNonemptyString(get(requested, "workspace_name"), ["requested", "workspace_name"]);
  const reqSession = requireNonemptyString(get(requested, "session_name"), ["requested", "session_name"]);

  const incoming = requireClosedObject(get(root, "incoming"), INCOMING_KEYS, ["incoming"]);
  const incNamespace = requireNonemptyString(get(incoming, "source_namespace"), ["incoming", "source_namespace"]);
  const incMessageId = requireNonemptyString(get(incoming, "source_message_id"), ["incoming", "source_message_id"]);
  const incDigest = requireSha256Hex(get(incoming, "source_payload_digest"), ["incoming", "source_payload_digest"]);

  const rawExisting = get(root, "existing");
  let existing: JcsObject | null = null;
  let exWorkspace = "", exSession = "", exNamespace = "", exMessageId = "", exDigest = "", exPublicId = "";
  if (rawExisting !== null) {
    existing = requireClosedObject(rawExisting, EXISTING_KEYS, ["existing"]);
    exWorkspace = requireNonemptyString(get(existing, "workspace_name"), ["existing", "workspace_name"]);
    exSession = requireNonemptyString(get(existing, "session_name"), ["existing", "session_name"]);
    exNamespace = requireNonemptyString(get(existing, "source_namespace"), ["existing", "source_namespace"]);
    exMessageId = requireNonemptyString(get(existing, "source_message_id"), ["existing", "source_message_id"]);
    exDigest = requireSha256Hex(get(existing, "source_payload_digest"), ["existing", "source_payload_digest"]);
    exPublicId = requireNanoid21(get(existing, "public_id"), ["existing", "public_id"]);
  }

  // ---- destination BEFORE namespace/ID/digest. The replay tuple has no
  // session, so a different destination is a scope error, not permission to
  // duplicate or move the message. ----
  if (existing !== null) {
    if (exWorkspace !== reqWorkspace) fail("scope_mismatch", ["existing", "workspace_name"], "existing message is in a different workspace");
    if (exSession !== reqSession) fail("scope_mismatch", ["existing", "session_name"], "existing message is in a different session");
  }

  // Project into the UNCHANGED accepted classifier: requested workspace becomes
  // the incoming workspace, the digest is renamed, the public id is renamed,
  // and session is omitted from that helper's closed shape.
  try {
    return sourceReplayOp(
      new Map<string, JcsValue>([
        ["workspace_name", reqWorkspace],
        ["source_namespace", incNamespace],
        ["source_message_id", incMessageId],
        ["content_digest", incDigest],
      ]),
      existing === null
        ? null
        : new Map<string, JcsValue>([
            ["workspace_name", exWorkspace],
            ["source_namespace", exNamespace],
            ["source_message_id", exMessageId],
            ["content_digest", exDigest],
            ["message_public_id", exPublicId],
          ]),
    );
  } catch (error) {
    // Re-anchor the helper's paths onto this wrapper's actual input field names.
    if (error instanceof ContractError) {
      let path = error.path;
      for (const [pattern, replacement] of HELPER_PATH_RENAMES) path = path.replace(pattern, replacement);
      throw new ContractError(error.code, path, error.message);
    }
    throw error;
  }
}
