import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContractError } from "../src/contracts/errors";
import { canonicalMessage, messageDigest } from "../src/contracts/v1";
import {
  classifyMessageDestinationReplay,
  mapLegacyMessageBoundary,
  prepareNewMessage,
  validateStoredSourceState,
} from "../src/contracts/source-ingestion-v1";

const F = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/source-ingestion-v1/expected.json", import.meta.url)), "utf8"));
const j = (v: unknown) => JSON.stringify(v);

function expectError(fn: () => unknown, code: string, path: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect([(error as ContractError).code, (error as ContractError).path]).toEqual([code, path]);
    return;
  }
  throw new Error(`expected ${code} at ${JSON.stringify(path)}`);
}

// ---------------------------------------------------------------------------
// 8.1 prepareNewMessage
// ---------------------------------------------------------------------------

describe("prepareNewMessage", () => {
  const LOCAL = F.local.input;
  const SOURCED = F.sourced.input;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  test("local mode: fixed expected output, all-null source quartet, created_at == ingested_at == intake", () => {
    expect(prepareNewMessage(j(LOCAL))).toEqual(F.local.output);
  });

  test("sourced mode: output matches the fixture's independently computed literal digest", () => {
    // F.sourced.output.source_payload_digest is a LITERAL hex string, computed
    // in Python via hashlib against a hand-authored preimage
    // (fixtures/source-ingestion-v1/expected.json -> sourced.independent_digest_check),
    // never by calling canonicalMessage/messageDigest. The module's output is
    // compared against that external value.
    expect(prepareNewMessage(j(SOURCED))).toEqual(F.sourced.output);
    // Separate cross-check, not the origin of the golden: the accepted codec
    // agrees with the same literal and with the pinned preimage bytes.
    const check = F.sourced.independent_digest_check;
    const bytes = canonicalMessage(F.sourced.envelope);
    expect(Buffer.from(bytes).toString("hex")).toBe(check.preimage_hex);
    expect(createHash("sha256").update("arra-message/v1\n", "utf8").update(bytes).digest("hex")).toBe(check.digest);
    expect(messageDigest(F.sourced.envelope)).toBe(F.sourced.output.source_payload_digest);
    // created_at prefers source time; ingested_at is always intake.
    const out = prepareNewMessage(j(SOURCED)) as Record<string, unknown>;
    expect(out.created_at).toBe(SOURCED.source.source_created_at);
    expect(out.ingested_at).toBe(SOURCED.context.intake_at);
    expect(out).not.toHaveProperty("supplied_digest");
  });

  test("sourced with no source time: created_at falls back to intake, source_created_at stays null", () => {
    const input = clone(SOURCED);
    input.source.source_created_at = null;
    const out = prepareNewMessage(j(input)) as Record<string, unknown>;
    expect([out.source_created_at, out.created_at, out.ingested_at]).toEqual([null, SOURCED.context.intake_at, SOURCED.context.intake_at]);
    expect(out.source_payload_digest).toBe(messageDigest({ ...F.sourced.envelope, source_created_at: null }));
  });

  test("namespace is INJECTED by configuration: untrusted message/source may not carry one", () => {
    const withMessageNs = clone(SOURCED);
    (withMessageNs.message as Record<string, unknown>).source_namespace = "attacker";
    expectError(() => prepareNewMessage(j(withMessageNs)), "unexpected_field", "/message/source_namespace");
    const withSourceNs = clone(SOURCED);
    (withSourceNs.source as Record<string, unknown>).source_namespace = "attacker";
    expectError(() => prepareNewMessage(j(withSourceNs)), "unexpected_field", "/source/source_namespace");
  });

  test("mode and configured namespace must agree, and that check precedes supplied-digest equality", () => {
    const localWithNs = clone(LOCAL);
    localWithNs.context.source_namespace = "relic://x";
    expectError(() => prepareNewMessage(j(localWithNs)), "invalid_value", "/context/source_namespace");
    const sourcedWithoutNs = clone(SOURCED);
    sourcedWithoutNs.context.source_namespace = null;
    sourcedWithoutNs.source.supplied_digest = "0".repeat(64); // also wrong -- mode error must win
    expectError(() => prepareNewMessage(j(sourcedWithoutNs)), "invalid_value", "/context/source_namespace");
  });

  test("supplied digest: matching passes, differing is digest_mismatch, malformed is invalid_value first", () => {
    const good = clone(SOURCED);
    good.source.supplied_digest = F.sourced.output.source_payload_digest; // the fixture's independent literal
    expect(prepareNewMessage(j(good))).toEqual(F.sourced.output);
    const wrong = clone(SOURCED);
    wrong.source.supplied_digest = "0".repeat(64);
    expectError(() => prepareNewMessage(j(wrong)), "digest_mismatch", "/source/supplied_digest");
    for (const bad of ["", "abc", "A".repeat(64), `${"a".repeat(63)}g`, " ".repeat(64)]) {
      const m = clone(SOURCED);
      m.source.supplied_digest = bad;
      expectError(() => prepareNewMessage(j(m)), "invalid_value", "/source/supplied_digest");
    }
  });

  test("every governed envelope field changes the digest; allocated/intake fields do not", () => {
    const base = prepareNewMessage(j(SOURCED)) as Record<string, string>;
    const vary = (path: [string, string], value: unknown) => {
      const input = clone(SOURCED) as Record<string, Record<string, unknown>>;
      input[path[0]]![path[1]] = value;
      return (prepareNewMessage(j(input)) as Record<string, string>).source_payload_digest;
    };
    const governed: Array<[[string, string], unknown]> = [
      [["message", "peer_name"], "neo"],
      [["message", "role"], null],
      [["message", "content"], "different"],
      [["message", "in_reply_to"], "Msg00000000000000009_"],
      [["source", "source_message_id"], "42"],
      [["source", "source_created_at"], null],
      [["context", "source_namespace"], "relic://other"],
    ];
    const seen = new Set([base.source_payload_digest]);
    for (const [path, value] of governed) {
      const d = vary(path, value);
      expect([path.join("."), d === base.source_payload_digest]).toEqual([path.join("."), false]);
      seen.add(d);
    }
    expect(seen.size).toBe(governed.length + 1);
    // Intake time is NOT in the envelope: it moves ingested_at but never the digest.
    const laterIntake = clone(SOURCED);
    laterIntake.context.intake_at = "2026-12-31T23:59:59.999Z";
    const later = prepareNewMessage(j(laterIntake)) as Record<string, string>;
    expect(later.source_payload_digest).toBe(base.source_payload_digest);
    expect(later.ingested_at).toBe("2026-12-31T23:59:59.999Z");
    // Workspace and session are outside the envelope too.
    const elsewhere = clone(SOURCED);
    elsewhere.context.workspace_name = "other";
    elsewhere.context.session_name = "s9";
    expect((prepareNewMessage(j(elsewhere)) as Record<string, string>).source_payload_digest).toBe(base.source_payload_digest);
  });

  test("source_message_id is opaque: leading zeros, case, slashes and spaces are distinct identities", () => {
    const digestFor = (id: string) => messageDigest({ ...F.sourced.envelope, source_message_id: id });
    const ids = ["00042", "42", "0042", " 42", "42 ", "4/2", "4a", "4A"];
    const digests = ids.map(digestFor);
    expect(new Set(digests).size).toBe(ids.length);
  });

  test("namespace exactness: Thai, spacing, case, trailing slash and scheme differences are distinct", () => {
    const names = ["relic/บัญชี-primary", "relic/บัญชี-primary ", "relic/บัญชี-Primary", "relic://claude/session/transcript", "relic://claude/session/transcript/", "RELIC://claude/session/transcript"];
    const digests = names.map((source_namespace) => messageDigest({ ...F.sourced.envelope, source_namespace }));
    expect(new Set(digests).size).toBe(names.length);
  });

  test("strict parse errors keep the parser's own code and path", () => {
    expectError(() => prepareNewMessage('{"context":{"a":1,"a":2}}'), "duplicate_key", "/context/a");
    expectError(() => prepareNewMessage('{"context":1} trailing'), "invalid_json", "");
    expectError(() => prepareNewMessage('{"content":"\\ud800"}'), "invalid_unicode", "/content");
    expectError(() => prepareNewMessage("[]"), "invalid_type", "");
  });

  test("closed shapes: missing keys in listed order, then unexpected keys in UTF-16 order", () => {
    const noContext = { message: LOCAL.message, source: null };
    expectError(() => prepareNewMessage(j(noContext)), "missing_field", "/context");
    const extraRoot = { ...LOCAL, zz: 1, aa: 2 };
    expectError(() => prepareNewMessage(j(extraRoot)), "unexpected_field", "/aa");
    const ctx = clone(LOCAL);
    delete (ctx.context as Record<string, unknown>).intake_at;
    expectError(() => prepareNewMessage(j(ctx)), "missing_field", "/context/intake_at");
  });

  test("value rules: empty S, invalid T, non-nanoid in_reply_to, wrong types", () => {
    const bad = (mutate: (v: any) => void, code: string, path: string) => {
      const input = clone(LOCAL);
      mutate(input);
      expectError(() => prepareNewMessage(j(input)), code, path);
    };
    bad((v) => (v.context.workspace_name = ""), "invalid_value", "/context/workspace_name");
    // Whitespace-only is a valid nonempty string: the contract's "no trim" rule
    // is about NAMESPACE/SOURCE-ID identity, not a blanket ban on whitespace text.
    const ws = clone(LOCAL); ws.context.session_name = "  \t ";
    expect((prepareNewMessage(j(ws)) as Record<string, unknown>).session_name).toBe("  \t ");
    bad((v) => (v.message.peer_name = ""), "invalid_value", "/message/peer_name");
    bad((v) => (v.message.content = 5), "invalid_type", "/message/content");
    bad((v) => (v.message.in_reply_to = "short"), "invalid_value", "/message/in_reply_to");
    bad((v) => (v.context.intake_at = "2026-09-20T10:15:42Z"), "invalid_value", "/context/intake_at");
    bad((v) => (v.context.intake_at = "2026-09-20T10:15:42.1205Z"), "invalid_value", "/context/intake_at");
    bad((v) => (v.message.role = 7), "invalid_type", "/message/role");
    // content may be empty; role may be null.
    const ok = clone(LOCAL);
    ok.message.content = "";
    ok.message.role = null;
    expect((prepareNewMessage(j(ok)) as Record<string, unknown>).content).toBe("");
  });

  test("deterministic mapping: identical input produces identical output", () => {
    const a = prepareNewMessage(j(SOURCED));
    const b = prepareNewMessage(j(SOURCED));
    expect(a).toEqual(b);
    expect((a as Record<string, unknown>).ingested_at).toBe(SOURCED.context.intake_at);
  });
});

// ---------------------------------------------------------------------------
// 8.2 validateStoredSourceState — the 16-combination presence matrix
// ---------------------------------------------------------------------------

describe("validateStoredSourceState", () => {
  const NS = "relic://claude/session/transcript";
  const ID = "00042";
  const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const TIME = "2026-09-18T03:39:42.000Z";
  const INGESTED = "2026-09-20T10:15:42.120Z";

  test("all 16 presence combinations: only all-null and the full triple (± time) are valid", () => {
    const results: Array<[string, boolean]> = [];
    for (let mask = 0; mask < 16; mask++) {
      const input = {
        source_namespace: mask & 8 ? NS : null,
        source_message_id: mask & 4 ? ID : null,
        source_payload_digest: mask & 2 ? DIGEST : null,
        source_created_at: mask & 1 ? TIME : null,
        ingested_at: INGESTED,
      };
      const tripleComplete = Boolean(mask & 8) && Boolean(mask & 4) && Boolean(mask & 2);
      const tripleEmpty = !(mask & 8) && !(mask & 4) && !(mask & 2);
      const expectedValid = tripleComplete || (tripleEmpty && !(mask & 1));
      let valid = true;
      try {
        expect(validateStoredSourceState(j(input))).toEqual(input);
      } catch {
        valid = false;
      }
      results.push([mask.toString(2).padStart(4, "0"), valid]);
      expect([mask.toString(2).padStart(4, "0"), valid]).toEqual([mask.toString(2).padStart(4, "0"), expectedValid]);
    }
    // Exactly three of sixteen are valid: 0000, 1110, 1111.
    expect(results.filter(([, v]) => v).map(([m]) => m)).toEqual(["0000", "1110", "1111"]);
  });

  test("partial triple reports /source_namespace; source time without a triple reports /source_created_at", () => {
    expectError(() => validateStoredSourceState(j({ source_namespace: NS, source_message_id: null, source_payload_digest: null, source_created_at: null, ingested_at: INGESTED })), "invalid_value", "/source_namespace");
    expectError(() => validateStoredSourceState(j({ source_namespace: null, source_message_id: null, source_payload_digest: null, source_created_at: TIME, ingested_at: INGESTED })), "invalid_value", "/source_created_at");
  });

  test("partial-triple check precedes the source-time check when both are wrong", () => {
    expectError(() => validateStoredSourceState(j({ source_namespace: NS, source_message_id: null, source_payload_digest: null, source_created_at: TIME, ingested_at: INGESTED })), "invalid_value", "/source_namespace");
  });

  test("structural and value errors precede the presence predicate", () => {
    // A malformed digest is a value error, not a partial-triple error.
    expectError(() => validateStoredSourceState(j({ source_namespace: NS, source_message_id: ID, source_payload_digest: "nope", source_created_at: null, ingested_at: INGESTED })), "invalid_value", "/source_payload_digest");
    expectError(() => validateStoredSourceState(j({ source_namespace: NS, source_message_id: "", source_payload_digest: DIGEST, source_created_at: null, ingested_at: INGESTED })), "invalid_value", "/source_message_id");
    expectError(() => validateStoredSourceState(j({ source_namespace: NS, source_message_id: ID, source_payload_digest: DIGEST, source_created_at: null })), "missing_field", "/ingested_at");
    expectError(() => validateStoredSourceState(j({ source_namespace: NS, source_message_id: ID, source_payload_digest: DIGEST, source_created_at: null, ingested_at: INGESTED, extra: 1 })), "unexpected_field", "/extra");
    expectError(() => validateStoredSourceState(j({ source_namespace: NS, source_message_id: ID, source_payload_digest: DIGEST, source_created_at: null, ingested_at: null })), "invalid_type", "/ingested_at");
  });

  test("returns the same values in the listed field order", () => {
    const input = { source_namespace: NS, source_message_id: ID, source_payload_digest: DIGEST, source_created_at: TIME, ingested_at: INGESTED };
    const out = validateStoredSourceState(j(input));
    expect(Object.keys(out as object)).toEqual(["source_namespace", "source_message_id", "source_payload_digest", "source_created_at", "ingested_at"]);
  });
});

// ---------------------------------------------------------------------------
// 8.3 mapLegacyMessageBoundary
// ---------------------------------------------------------------------------

describe("mapLegacyMessageBoundary", () => {
  const LEGACY = F.legacy.input;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  test("fixed expected output: legacy id/public_id/sequence preserved, ingested_at is the frozen migration intake", () => {
    expect(mapLegacyMessageBoundary(j(LEGACY))).toEqual(F.legacy.output);
  });

  test("deterministic mapping: identical input produces identical output on replay", () => {
    expect(mapLegacyMessageBoundary(j(LEGACY))).toEqual(mapLegacyMessageBoundary(j(LEGACY)));
  });

  test("assumptions is a returned report field naming the intake basis", () => {
    const out = mapLegacyMessageBoundary(j(LEGACY)) as { assumptions: string[]; ingested_at: string };
    expect(out.assumptions).toEqual(["ingested_at=migration_intake;original_ingestion_unknown"]);
    expect(out.ingested_at).toBe(LEGACY.context.migration_intake_at);
    // ingested_at is NOT silently set to created_at.
    expect(out.ingested_at).not.toBe((F.legacy.output as { created_at: string }).created_at);
  });

  test("raw microseconds: divisible values convert, sub-millisecond is out_of_range and never rounded", () => {
    const at = (us: string) => {
      const input = clone(LEGACY);
      input.legacy.created_at_us = us;
      return mapLegacyMessageBoundary(j(input)) as { created_at: string };
    };
    expect(at("1758166782000000").created_at).toBe("2025-09-18T03:39:42.000Z");
    expect(at("0").created_at).toBe("1970-01-01T00:00:00.000Z");
    expect(at("-1000").created_at).toBe("1969-12-31T23:59:59.999Z"); // negative epoch is valid
    for (const us of ["1758166782000001", "1", "-1", "999", "-1758166782000001"]) {
      const input = clone(LEGACY);
      input.legacy.created_at_us = us;
      expectError(() => mapLegacyMessageBoundary(j(input)), "out_of_range", "/legacy/created_at_us");
    }
  });

  test("far-calendar microseconds are rejected before conversion, on both sides of the supported range", () => {
    const outside = [
      "253402300800000000",   // year 10000
      "-62135596800001000",   // before 0001-01-01
      "9223372036854775000",  // near Int64 max, far past year 9999
      "-9223372036854775000",
    ];
    for (const us of outside) {
      const input = clone(LEGACY);
      input.legacy.created_at_us = us;
      expectError(() => mapLegacyMessageBoundary(j(input)), "out_of_range", "/legacy/created_at_us");
    }
    // The boundary itself is inside the range.
    const edge = clone(LEGACY);
    edge.legacy.created_at_us = "253402300799999000";
    expect((mapLegacyMessageBoundary(j(edge)) as { created_at: string }).created_at).toBe("9999-12-31T23:59:59.999Z");
  });

  test("non-canonical Int64 SYNTAX rejects as invalid_value, before any arithmetic", () => {
    // Malformed spelling only. A syntactically valid but out-of-range value
    // is a DIFFERENT case -- see the out_of_range boundary test below.
    for (const [field, value, code] of [
      ["created_at_us", "01", "invalid_value"],
      ["created_at_us", " 1000", "invalid_value"],
      ["created_at_us", "1e6", "invalid_value"],
      ["created_at_us", 1000, "invalid_type"],
      ["seq_in_session", "-0", "invalid_value"],
    ] as Array<[string, unknown, string]>) {
      const input = clone(LEGACY);
      (input.legacy as Record<string, unknown>)[field] = value;
      expectError(() => mapLegacyMessageBoundary(j(input)), code, `/legacy/${field}`);
    }
  });

  test("a CANONICAL decimal longer than 20 characters is out_of_range regardless of digit count, never invalid_value", () => {
    // Regression: an earlier version bundled the length shortcut into the
    // SYNTAX branch, so a well-formed but long decimal (e.g. 21 digits) was
    // misreported as invalid_value instead of out_of_range. Codex's
    // independent probe caught this on /legacy/id.
    const positive21 = "100000000000000000000"; // 21 digits, canonical, no leading zero
    const negative21 = "-100000000000000000000"; // sign + 21 digits, canonical
    const longCanonical = "1" + "0".repeat(80); // 81-digit canonical decimal
    const longMalformed = "0" + "1".repeat(80); // 81 characters, LEADING ZERO -- malformed, not just long
    for (const field of ["id", "seq_in_session", "created_at_us"] as const) {
      for (const value of [positive21, negative21, longCanonical]) {
        const input = clone(LEGACY);
        (input.legacy as Record<string, unknown>)[field] = value;
        expectError(() => mapLegacyMessageBoundary(j(input)), "out_of_range", `/legacy/${field}`);
      }
      // Malformed spelling stays invalid_value no matter how long the text is --
      // length alone must never upgrade a syntax error into a range error.
      const input = clone(LEGACY);
      (input.legacy as Record<string, unknown>)[field] = longMalformed;
      expectError(() => mapLegacyMessageBoundary(j(input)), "invalid_value", `/legacy/${field}`);
    }
  });

  test("Int64 magnitude OUTSIDE the signed 64-bit range is out_of_range, on all three legacy Int64 fields, at exactly ±1 from each bound", () => {
    // Local `requireInt64Ranged` splits this from the shared common.ts
    // helper's invalid_value-for-everything behavior, per section9.
    const INT64_MAX = "9223372036854775807";
    const OVER_MAX = "9223372036854775808";
    const INT64_MIN = "-9223372036854775808";
    const UNDER_MIN = "-9223372036854775809";
    for (const field of ["id", "seq_in_session", "created_at_us"] as const) {
      for (const value of [OVER_MAX, UNDER_MIN]) {
        const input = clone(LEGACY);
        (input.legacy as Record<string, unknown>)[field] = value;
        expectError(() => mapLegacyMessageBoundary(j(input)), "out_of_range", `/legacy/${field}`);
      }
      // The exact boundary values themselves are IN range at the Int64 parse
      // level. id and seq_in_session accept them outright; created_at_us also
      // requires ms-divisibility and the narrower Gregorian range, so it is
      // checked against a divisible-by-1000 boundary instead of the raw edge.
      if (field === "created_at_us") continue;
      for (const value of [INT64_MAX, INT64_MIN]) {
        const input = clone(LEGACY);
        (input.legacy as Record<string, unknown>)[field] = value;
        const out = mapLegacyMessageBoundary(j(input)) as Record<string, unknown>;
        expect(out[field]).toBe(value);
      }
    }
  });

  test("this function is source-LESS only: ANY non-null legacy source field rejects, whatever its type, first in listed order", () => {
    const fields = ["source_namespace", "source_message_id", "source_payload_digest", "source_created_at"] as const;
    // Presence alone decides -- there is no intermediate type check. A number,
    // boolean, array or object is exactly as much "not source-less" as a
    // string, so ALL of these produce the same invalid_value at the same field.
    const nonNullValues: unknown[] = ["x", 7, false, [], {}];
    for (const field of fields) {
      for (const value of nonNullValues) {
        const input = clone(LEGACY);
        (input.legacy as Record<string, unknown>)[field] = value;
        expectError(() => mapLegacyMessageBoundary(j(input)), "invalid_value", `/legacy/${field}`);
      }
    }
    // With several set, the FIRST in listed order is reported.
    const many = clone(LEGACY);
    (many.legacy as Record<string, unknown>).source_message_id = "x";
    (many.legacy as Record<string, unknown>).source_payload_digest = "y";
    expectError(() => mapLegacyMessageBoundary(j(many)), "invalid_value", "/legacy/source_message_id");
    // Mixed types across fields: still first in LISTED order, not first by type.
    const mixed = clone(LEGACY);
    (mixed.legacy as Record<string, unknown>).source_message_id = 7;
    (mixed.legacy as Record<string, unknown>).source_payload_digest = "y";
    expectError(() => mapLegacyMessageBoundary(j(mixed)), "invalid_value", "/legacy/source_message_id");
  });

  test("source-less check precedes the physical-time precision check", () => {
    const both = clone(LEGACY);
    (both.legacy as Record<string, unknown>).source_namespace = "x";
    both.legacy.created_at_us = "1758166782000001";
    expectError(() => mapLegacyMessageBoundary(j(both)), "invalid_value", "/legacy/source_namespace");
  });

  test("an invalid legacy public handle is a value error held for #34 mapping, not regenerated", () => {
    const input = clone(LEGACY);
    input.legacy.public_id = "not-a-nanoid";
    expectError(() => mapLegacyMessageBoundary(j(input)), "invalid_value", "/legacy/public_id");
  });
});

// ---------------------------------------------------------------------------
// 8.4 classifyMessageDestinationReplay
// ---------------------------------------------------------------------------

describe("classifyMessageDestinationReplay", () => {
  const NS = "relic://claude/session/transcript";
  const ID = "00042";
  const D1 = "a".repeat(64);
  const D2 = "b".repeat(64);
  const PUB = "Msg00000000000000001_";
  const base = (over: Record<string, unknown> = {}) => ({
    requested: { workspace_name: "w", session_name: "s1" },
    incoming: { source_namespace: NS, source_message_id: ID, source_payload_digest: D1 },
    existing: { workspace_name: "w", session_name: "s1", source_namespace: NS, source_message_id: ID, source_payload_digest: D1, public_id: PUB },
    ...over,
  });

  test("null existing is new; matching identity and digest is idempotent with the existing public id", () => {
    expect(classifyMessageDestinationReplay(j(base({ existing: null })))).toEqual({ outcome: "new", original_id: null });
    expect(classifyMessageDestinationReplay(j(base()))).toEqual({ outcome: "idempotent", original_id: PUB });
  });

  test("same identity, different digest is conflict with no original id", () => {
    const input = base();
    (input.existing as Record<string, unknown>).source_payload_digest = D2;
    expect(classifyMessageDestinationReplay(j(input))).toEqual({ outcome: "conflict", original_id: null });
  });

  test("a different destination is scope_mismatch, not permission to duplicate or move", () => {
    const wrongWorkspace = base();
    (wrongWorkspace.existing as Record<string, unknown>).workspace_name = "other";
    expectError(() => classifyMessageDestinationReplay(j(wrongWorkspace)), "scope_mismatch", "/existing/workspace_name");
    const wrongSession = base();
    (wrongSession.existing as Record<string, unknown>).session_name = "s2";
    expectError(() => classifyMessageDestinationReplay(j(wrongSession)), "scope_mismatch", "/existing/session_name");
    // Workspace outranks session when both differ.
    const both = base();
    (both.existing as Record<string, unknown>).workspace_name = "other";
    (both.existing as Record<string, unknown>).session_name = "s2";
    expectError(() => classifyMessageDestinationReplay(j(both)), "scope_mismatch", "/existing/workspace_name");
  });

  test("destination check precedes namespace/source-id comparison, and helper errors are re-anchored to this input", () => {
    const wrongEverything = base();
    Object.assign(wrongEverything.existing as Record<string, unknown>, { session_name: "s2", source_namespace: "other", source_message_id: "42" });
    expectError(() => classifyMessageDestinationReplay(j(wrongEverything)), "scope_mismatch", "/existing/session_name");
    // With the destination correct, the helper's namespace/ID scope checks surface under OUR paths.
    const wrongNs = base();
    (wrongNs.existing as Record<string, unknown>).source_namespace = "other";
    expectError(() => classifyMessageDestinationReplay(j(wrongNs)), "scope_mismatch", "/existing/source_namespace");
    const wrongId = base();
    (wrongId.existing as Record<string, unknown>).source_message_id = "42";
    expectError(() => classifyMessageDestinationReplay(j(wrongId)), "scope_mismatch", "/existing/source_message_id");
  });

  test("helper field names are translated back: content_digest and message_public_id never appear in a path", () => {
    const badDigest = base();
    (badDigest.existing as Record<string, unknown>).source_payload_digest = "nope";
    expectError(() => classifyMessageDestinationReplay(j(badDigest)), "invalid_value", "/existing/source_payload_digest");
    const badPub = base();
    (badPub.existing as Record<string, unknown>).public_id = "short";
    expectError(() => classifyMessageDestinationReplay(j(badPub)), "invalid_value", "/existing/public_id");
    const badIncoming = base();
    (badIncoming.incoming as Record<string, unknown>).source_payload_digest = "nope";
    expectError(() => classifyMessageDestinationReplay(j(badIncoming)), "invalid_value", "/incoming/source_payload_digest");
  });

  test("a malformed existing digest outranks a destination mismatch; a valid differing digest does not", () => {
    // Structural/value validation of the WHOLE input precedes semantic comparison.
    const malformedAndWrongDestination = base();
    Object.assign(malformedAndWrongDestination.existing as Record<string, unknown>, { workspace_name: "other", source_payload_digest: "nope" });
    expectError(() => classifyMessageDestinationReplay(j(malformedAndWrongDestination)), "invalid_value", "/existing/source_payload_digest");
    // A well-formed but different digest does NOT outrank destination scope.
    const differingAndWrongDestination = base();
    Object.assign(differingAndWrongDestination.existing as Record<string, unknown>, { workspace_name: "other", source_payload_digest: D2 });
    expectError(() => classifyMessageDestinationReplay(j(differingAndWrongDestination)), "scope_mismatch", "/existing/workspace_name");
  });

  test("closed shapes and required keys, including the omitted session in the helper's own shape", () => {
    expectError(() => classifyMessageDestinationReplay(j({ requested: base().requested, incoming: base().incoming })), "missing_field", "/existing");
    const extra = base() as Record<string, unknown>;
    (extra.incoming as Record<string, unknown>).session_name = "s1";
    expectError(() => classifyMessageDestinationReplay(j(extra)), "unexpected_field", "/incoming/session_name");
    const missing = base();
    delete (missing.requested as Record<string, unknown>).session_name;
    expectError(() => classifyMessageDestinationReplay(j(missing)), "missing_field", "/requested/session_name");
  });

  test("source ids differing only by leading zeros are different identities", () => {
    const input = base();
    (input.incoming as Record<string, unknown>).source_message_id = "42";
    (input.existing as Record<string, unknown>).source_message_id = "00042";
    expectError(() => classifyMessageDestinationReplay(j(input)), "scope_mismatch", "/existing/source_message_id");
  });
});

// ---------------------------------------------------------------------------
// Preservation of the accepted message codec
// ---------------------------------------------------------------------------

describe("existing message bytes are untouched", () => {
  test("the seven-field envelope, its order and its digest domain are unchanged", () => {
    const envelope = F.sourced.envelope;
    expect(Object.keys(envelope)).toEqual(["source_namespace", "source_message_id", "peer_name", "role", "content", "source_created_at", "in_reply_to"]);
    const bytes = canonicalMessage(envelope);
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(envelope));
    expect(messageDigest(envelope)).toBe(createHash("sha256").update("arra-message/v1\n", "utf8").update(bytes).digest("hex"));
  });

  test("prepareNewMessage produces exactly the digest the standalone codec produces", () => {
    const out = prepareNewMessage(j(F.sourced.input)) as { source_payload_digest: string };
    expect(out.source_payload_digest).toBe(messageDigest(F.sourced.envelope));
  });
});
