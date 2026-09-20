import { describe, expect, test } from "bun:test";
import { newId, validateId, parseInt64, formatInt64, parseTimestamp, formatTimestamp, canonicalMessage, messageDigest, sourceReplayOutcome } from "../src/contracts/v1";

export const messageFixture = {
  source_namespace: "relic://claude/session/transcript",
  source_message_id: "275",
  peer_name: "nat",
  role: "user",
  content: 'ความทรงจำ 🌱\n"quote"\\slash\t\u0000\u2028e\u0301',
  source_created_at: "2026-09-18T03:39:42.120Z",
  in_reply_to: null,
};

describe("candidate v1 closed codecs (not active storage migration)", () => {
  test("opaque cryptographic IDs have the pinned alphabet and length", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(validateId(id)).toBe(id);
    for (const invalid of ["", "x".repeat(20), "x".repeat(22), "a".repeat(20) + "é", "a".repeat(20) + "\n", 12, null]) {
      expect(() => validateId(invalid)).toThrow();
    }
  });

  test("Int64 is always canonical decimal text at the boundary", () => {
    for (const valid of ["0", "-1", "9007199254740993", "9223372036854775807", "-9223372036854775808"]) {
      expect(formatInt64(parseInt64(valid))).toBe(valid);
    }
    for (const invalid of ["-0", "01", "+1", " 1", "1\n", "1.0", "1e3", "9223372036854775808", "-9223372036854775809", 1, null]) {
      expect(() => parseInt64(invalid)).toThrow();
    }
    expect(() => formatInt64(9223372036854775808n)).toThrow();
  });

  test("UTC millisecond timestamps are exact, calendar-valid, and unambiguous", () => {
    for (const valid of ["0001-01-01T00:00:00.000Z", "2024-02-29T23:59:59.123Z", "9999-12-31T23:59:59.999Z"]) {
      expect(formatTimestamp(parseTimestamp(valid))).toBe(valid);
    }
    for (const invalid of ["0000-01-01T00:00:00.000Z", "2026-02-29T00:00:00.000Z", "2026-09-20T24:00:00.000Z", "2026-09-20T00:00:60.000Z", "2026-09-20T00:00:00.000001Z", "2026-09-20T00:00:00.000+00:00", "2026-09-20", null]) {
      expect(() => parseTimestamp(invalid)).toThrow();
    }
    expect(() => formatTimestamp(new Date(NaN))).toThrow();
  });

  test("message digest is deterministic without Unicode normalization", () => {
    const bytes = canonicalMessage(messageFixture);
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(messageFixture));
    expect(messageDigest({ ...messageFixture })).toMatch(/^[a-f0-9]{64}$/);
    expect(messageDigest(Object.fromEntries(Object.entries(messageFixture).reverse()))).toBe(messageDigest(messageFixture));
    expect(messageDigest({ ...messageFixture, content: "é" })).not.toBe(messageDigest({ ...messageFixture, content: "e\u0301" }));
    expect(messageDigest({ ...messageFixture, source_message_id: "276" })).not.toBe(messageDigest(messageFixture));
  });

  test("source replay distinguishes new, same-payload retry and changed payload", () => {
    const digest = messageDigest(messageFixture);
    expect(sourceReplayOutcome(null, digest)).toBe("new");
    expect(sourceReplayOutcome(digest, digest)).toBe("idempotent");
    expect(sourceReplayOutcome("0".repeat(64), digest)).toBe("conflict");
    expect(() => sourceReplayOutcome(null, "BAD")).toThrow();
    expect(() => sourceReplayOutcome("BAD", digest)).toThrow();
  });

  test("closed message envelope rejects omission, extras, invalid strings and time", () => {
    const { in_reply_to: _, ...omitted } = messageFixture;
    for (const invalid of [omitted, { ...messageFixture, ingested_at: "ignored?" }, { ...messageFixture, content: "\ud800" }, { ...messageFixture, peer_name: "" }, { ...messageFixture, role: 7 }, { ...messageFixture, source_created_at: "yesterday" }]) {
      expect(() => canonicalMessage(invalid)).toThrow();
    }
    expect(() => canonicalMessage({ ...messageFixture, role: null, source_created_at: null })).not.toThrow();
  });
});
