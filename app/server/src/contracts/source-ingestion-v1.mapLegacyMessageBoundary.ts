import { fail } from "./errors";
import { requireClosedObject, requireNanoid21, requireNonemptyString, requireTimestampString } from "./common";
import { formatTimestamp } from "./v1";
import { get } from "./source-ingestion-v1.get";
import { parseRoot } from "./source-ingestion-v1.parseRoot";
import { requireInt64Ranged } from "./source-ingestion-v1.requireInt64Ranged";

const LEGACY_CONTEXT_KEYS = ["workspace_name", "session_name", "migration_intake_at"] as const;
const LEGACY_KEYS = [
  "id", "public_id", "seq_in_session", "created_at_us",
  "source_namespace", "source_message_id", "source_payload_digest", "source_created_at",
] as const;
const LEGACY_SOURCE_FIELDS = ["source_namespace", "source_message_id", "source_payload_digest", "source_created_at"] as const;

const LEGACY_INTAKE_ASSUMPTION = "ingested_at=migration_intake;original_ingestion_unknown";

/** Microsecond bounds of the supported Gregorian range, 0001-01-01 .. 9999-12-31T23:59:59.999Z. */
const MIN_SUPPORTED_US = -62135596800000n * 1000n;
const MAX_SUPPORTED_US = 253402300799999n * 1000n;

// ---------------------------------------------------------------------------
// 8.3 mapLegacyMessageBoundary
// ---------------------------------------------------------------------------

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
