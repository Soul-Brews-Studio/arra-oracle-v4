import { requireBoundedText, requireClosedObject, requireNonemptyString, type Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import type { JcsValue } from "../contracts/jcs";
import { normalizeTarget } from "../contracts/evidence-v1";
import { targetKind } from "./trace.targetKind";
import { nullableInt64Text } from "./trace.nullableInt64Text";
import { nullableLongText } from "./trace.nullableLongText";
import { nullableShortText } from "./trace.nullableShortText";
import { nullableCapturedAt } from "./trace.nullableCapturedAt";
import type { CreateTraceHitInput } from "./trace.types";

const MAX_REF_BYTES = 2048;

const CREATE_HIT_KEYS = [
  "kind",
  "target",
  "ref",
  "line_start",
  "line_end",
  "excerpt",
  "content_hash",
  "captured_at",
  "note",
] as const;

export function parseHit(value: JcsValue, tokens: Tokens): CreateTraceHitInput {
  const o = requireClosedObject(value, CREATE_HIT_KEYS, tokens);
  const kind = targetKind(o.get("kind"), [...tokens, "kind"]);
  const target = o.get("target") ?? null;
  if (target === null) fail("missing_field", [...tokens, "target"], "target is required");
  // Structural + per-kind normalization happens here, EAGERLY, so a malformed
  // target is refused at parse time rather than deep inside a queued write.
  // The result is discarded; `service.ts` re-derives the canonical text
  // against the trace's resolved workspace_name, which this module does not
  // itself decide.
  normalizeTarget(kind, target, [...tokens, "target"]);
  return {
    kind,
    target,
    ref: requireBoundedText(requireNonemptyString(o.get("ref") ?? null, [...tokens, "ref"]), MAX_REF_BYTES, [
      ...tokens,
      "ref",
    ]),
    line_start: nullableInt64Text(o.get("line_start"), [...tokens, "line_start"]),
    line_end: nullableInt64Text(o.get("line_end"), [...tokens, "line_end"]),
    excerpt: nullableLongText(o.get("excerpt"), [...tokens, "excerpt"]),
    content_hash: nullableShortText(o.get("content_hash"), [...tokens, "content_hash"]),
    captured_at: nullableCapturedAt(o.get("captured_at"), [...tokens, "captured_at"]),
    note: nullableLongText(o.get("note"), [...tokens, "note"]),
  };
}
