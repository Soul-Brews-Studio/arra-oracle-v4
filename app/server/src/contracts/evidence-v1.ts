/**
 * Closed evidence targets and their derived canonical identity — candidate v1.
 *
 * Eleven target kinds, each with EXACT keys. Normalization is limited to what
 * the contract names: GitHub `owner/repo` and git OIDs lowercase; everything
 * else is preserved byte-for-byte, including URLs, which are validated by the
 * WHATWG parser but never rewritten by it.
 *
 *   target_key = sha256("arra-target/v1\n" || JCS({workspace_name, target_kind, identity}))
 *
 * Identity drops display-only fields (relic_session.title_snapshot, and the
 * issue/discussion url); otherwise it is the whole normalized target. This
 * module proves equal/unequal keys and reconstruction. It implements no
 * lookup, permission check or dependency graph, and performs no network fetch.
 *
 * Contract: app/docs/contracts/revision-evidence-v1.md §5.
 */

import { fail } from "./errors";
import { canonicalize, type JcsObject, type JcsValue, obj, parseStrict } from "./jcs";
import {
  requireClosedObject,
  requireEnum,
  requireNanoid21,
  requireNonemptyString,
  requireNonNegativeInt64String,
  requireNullableString,
  requirePositiveInt64String,
  requireSha256Hex,
  requireUnicodeString,
  sha256HexWithDomain,
  type Tokens,
} from "./common";

export const TARGET_DOMAIN = "arra-target/v1\n";

export const TARGET_KINDS = [
  "node_revision", "trace", "message", "session",
  "relic_session", "relic_event",
  "code", "commit", "issue", "discussion", "url",
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Exact key order per kind. Traversal for errors follows this order. */
export const TARGET_KEYS: Record<TargetKind, readonly string[]> = {
  node_revision: ["node_id", "revision_id"],
  trace: ["trace_id"],
  message: ["session_name", "message_public_id"],
  session: ["session_name"],
  relic_session: ["source_bank", "provider", "session_uuid", "title_snapshot"],
  relic_event: ["source_bank", "provider", "session_uuid", "transcript_ref", "event_seq", "capture_digest"],
  code: ["repo", "commit", "path", "line_start", "line_end"],
  commit: ["repo", "commit"],
  issue: ["repo", "number", "url"],
  discussion: ["repo", "number", "url", "comment_id"],
  url: ["url"],
};

/** Keys excluded from identity (display only). */
const DISPLAY_ONLY: Partial<Record<TargetKind, readonly string[]>> = {
  relic_session: ["title_snapshot"],
  issue: ["url"],
  discussion: ["url"],
};

// ---------------------------------------------------------------------------
// Component validators
// ---------------------------------------------------------------------------

const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** GitHub-only `owner/repo`. Lowercased ASCII. `.git` is NOT stripped. */
export function normalizeRepo(value: JcsValue, tokens: Tokens): string {
  const s = requireUnicodeString(value, tokens);
  const parts = s.split("/");
  if (parts.length !== 2) fail("invalid_value", tokens, "repo must be exactly owner/repo");
  for (const part of parts) {
    if (part.length === 0 || !REPO_SEGMENT.test(part)) fail("invalid_value", tokens, "repo segments must be nonempty [A-Za-z0-9_.-]");
    if (part === "." || part === "..") fail("invalid_value", tokens, "repo segment may not be . or ..");
  }
  return s.toLowerCase();
}

/** `{algorithm, oid}`; full 40-hex sha1 or 64-hex sha256, lowercased. No abbreviations, no refs. */
export function normalizeCommit(value: JcsValue, tokens: Tokens): JcsObject {
  const o = requireClosedObject(value, ["algorithm", "oid"], tokens);
  const algorithm = requireEnum(o.get("algorithm")!, ["sha1", "sha256"] as const, [...tokens, "algorithm"]);
  const oidRaw = requireUnicodeString(o.get("oid")!, [...tokens, "oid"]);
  const want = algorithm === "sha1" ? 40 : 64;
  if (oidRaw.length !== want || !/^[0-9a-fA-F]+$/.test(oidRaw)) {
    fail("invalid_value", [...tokens, "oid"], `${algorithm} oid must be exactly ${want} hex characters`);
  }
  return obj({ algorithm, oid: oidRaw.toLowerCase() });
}

/** Repository-relative `/` path. Exact text; no normalization or casefold. */
export function requireCodePath(value: JcsValue, tokens: Tokens): string {
  const s = requireNonemptyString(value, tokens);
  if (s.startsWith("/") || s.endsWith("/")) fail("invalid_value", tokens, "path must not start or end with /");
  if (s.includes("\\")) fail("invalid_value", tokens, "path must not contain backslash");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) fail("invalid_value", tokens, "path must not contain control characters");
  }
  for (const seg of s.split("/")) {
    if (seg.length === 0) fail("invalid_value", tokens, "path must not contain empty segments");
    if (seg === "." || seg === "..") fail("invalid_value", tokens, "path segment may not be . or ..");
  }
  return s;
}

/**
 * Passive URL validation: a raw check, then WHATWG `new URL(raw)` with NO base
 * for validation only. The ORIGINAL string is what gets preserved and hashed;
 * the parser's rewritten form is discarded. No fetch.
 */
export function requireUrl(value: JcsValue, tokens: Tokens): string {
  const raw = requireNonemptyString(value, tokens);
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) fail("invalid_value", tokens, "url must not contain ASCII control, space or DEL");
  }
  if (raw.includes("\\")) fail("invalid_value", tokens, "url must not contain backslash");
  if (raw !== raw.trim()) fail("invalid_value", tokens, "url must not have leading or trailing whitespace");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail("invalid_value", tokens, "url does not parse");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("invalid_value", tokens, "url protocol must be http or https");
  if (parsed.hostname.length === 0) fail("invalid_value", tokens, "url hostname must be nonempty");
  if (parsed.username !== "" || parsed.password !== "") fail("invalid_value", tokens, "url must not carry credentials");
  return raw;
}

// ---------------------------------------------------------------------------
// Per-kind normalization
// ---------------------------------------------------------------------------

export function requireTargetKind(value: JcsValue, tokens: Tokens): TargetKind {
  return requireEnum(value, TARGET_KINDS, tokens);
}

/** Validate and normalize one typed target. Returns a fresh Map in key order. */
export function normalizeTarget(kind: TargetKind, value: JcsValue, tokens: Tokens): JcsObject {
  const keys = TARGET_KEYS[kind];
  const o = requireClosedObject(value, keys, tokens);
  const t = (k: string): Tokens => [...tokens, k];
  const g = (k: string): JcsValue => o.get(k) as JcsValue;

  switch (kind) {
    case "node_revision":
      return obj({ node_id: requireNanoid21(g("node_id"), t("node_id")), revision_id: requireNanoid21(g("revision_id"), t("revision_id")) });
    case "trace":
      return obj({ trace_id: requireNonemptyString(g("trace_id"), t("trace_id")) });
    case "message":
      return obj({ session_name: requireNonemptyString(g("session_name"), t("session_name")), message_public_id: requireNanoid21(g("message_public_id"), t("message_public_id")) });
    case "session":
      return obj({ session_name: requireNonemptyString(g("session_name"), t("session_name")) });
    case "relic_session":
      return obj({
        source_bank: requireNonemptyString(g("source_bank"), t("source_bank")),
        provider: requireNonemptyString(g("provider"), t("provider")),
        session_uuid: requireNonemptyString(g("session_uuid"), t("session_uuid")),
        title_snapshot: requireNullableString(g("title_snapshot"), t("title_snapshot")),
      });
    case "relic_event":
      return obj({
        source_bank: requireNonemptyString(g("source_bank"), t("source_bank")),
        provider: requireNonemptyString(g("provider"), t("provider")),
        session_uuid: requireNonemptyString(g("session_uuid"), t("session_uuid")),
        transcript_ref: requireNonemptyString(g("transcript_ref"), t("transcript_ref")),
        event_seq: requireNonNegativeInt64String(g("event_seq"), t("event_seq")).text,
        capture_digest: requireSha256Hex(g("capture_digest"), t("capture_digest")),
      });
    case "code": {
      const repo = normalizeRepo(g("repo"), t("repo"));
      const commit = normalizeCommit(g("commit"), t("commit"));
      const path = requireCodePath(g("path"), t("path"));
      const ls = g("line_start"), le = g("line_end");
      if ((ls === null) !== (le === null)) fail("invalid_value", t("line_end"), "line_start and line_end must both be null or both set");
      let line_start: string | null = null, line_end: string | null = null;
      if (ls !== null) {
        const a = requirePositiveInt64String(ls, t("line_start"));
        const b = requirePositiveInt64String(le, t("line_end"));
        if (a.value > b.value) fail("out_of_range", t("line_end"), "line_end must be >= line_start");
        line_start = a.text; line_end = b.text;
      }
      return obj({ repo, commit, path, line_start, line_end });
    }
    case "commit":
      return obj({ repo: normalizeRepo(g("repo"), t("repo")), commit: normalizeCommit(g("commit"), t("commit")) });
    case "issue":
      return obj({ repo: normalizeRepo(g("repo"), t("repo")), number: requirePositiveInt64String(g("number"), t("number")).text, url: requireUrl(g("url"), t("url")) });
    case "discussion":
      return obj({
        repo: normalizeRepo(g("repo"), t("repo")),
        number: requirePositiveInt64String(g("number"), t("number")).text,
        url: requireUrl(g("url"), t("url")),
        comment_id: g("comment_id") === null ? null : requirePositiveInt64String(g("comment_id"), t("comment_id")).text,
      });
    case "url":
      return obj({ url: requireUrl(g("url"), t("url")) });
  }
}

/** Identity = normalized target minus display-only keys. */
export function identityOf(kind: TargetKind, normalized: JcsObject): JcsObject {
  const drop = new Set(DISPLAY_ONLY[kind] ?? []);
  const out: JcsObject = new Map();
  for (const [k, v] of normalized) if (!drop.has(k)) out.set(k, v);
  return out;
}

export type TargetResult = { target_json: string; key_json: string; target_key: string };

/** `target` op: normalize, derive key. */
export function targetOp(workspaceName: JcsValue, kind: JcsValue, target: JcsValue, tokens: Tokens = []): TargetResult {
  const workspace_name = requireNonemptyString(workspaceName, [...tokens, "workspace_name"]);
  const target_kind = requireTargetKind(kind, [...tokens, "target_kind"]);
  const normalized = normalizeTarget(target_kind, target, [...tokens, "target"]);
  const target_json = canonicalize(normalized, [...tokens, "target"]);
  const keyObject = obj({ workspace_name, target_kind, identity: identityOf(target_kind, normalized) });
  const key_json = canonicalize(keyObject, tokens);
  const target_key = sha256HexWithDomain(TARGET_DOMAIN, key_json);
  return { target_json, key_json, target_key };
}

/**
 * `verify_target` op: `target_json` is raw STORED text that must already be
 * canonical; the recomputed key must equal `target_key`.
 */
export function verifyTargetOp(workspaceName: JcsValue, kind: JcsValue, targetJson: JcsValue, targetKey: JcsValue, tokens: Tokens = []): TargetResult {
  const target_kind = requireTargetKind(kind, [...tokens, "target_kind"]);
  const text = requireUnicodeString(targetJson, [...tokens, "target_json"]);
  const parsed = parseStrict(text, [...tokens, "target_json"]);
  const result = targetOp(workspaceName, target_kind, parsed, tokens);
  if (result.target_json !== text) fail("invalid_value", [...tokens, "target_json"], "stored target_json is not canonical");
  const supplied = requireSha256Hex(targetKey, [...tokens, "target_key"]);
  if (supplied !== result.target_key) fail("target_key_mismatch", [...tokens, "target_key"], "target_key does not match derived key");
  return result;
}
