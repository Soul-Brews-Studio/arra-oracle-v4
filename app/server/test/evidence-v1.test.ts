import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ContractError } from "../src/contracts/errors";
import { obj, parseStrict, type JcsValue } from "../src/contracts/jcs";
import { TARGET_KINDS, TARGET_KEYS, targetOp, verifyTargetOp } from "../src/contracts/evidence-v1";

const W = "บัญชี-primary";
const ID_A = "Node0000000000000001_", ID_B = "Revn0000000000000001_";
const SHA1 = "861809475895ecaf696fc8e2de435fbcd181ce62";
const SHA256 = "9369ccdd7d96419b31f6710f3dfbc39e774f828b".padEnd(64, "0");
const DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const j = (text: string): JcsValue => parseStrict(text);
const run = (kind: string, target: JcsValue, w = W) => targetOp(w, kind, target);
function expectError(fn: () => unknown, code: string, path: string) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect([(error as ContractError).code, (error as ContractError).path]).toEqual([code, path]);
    return;
  }
  throw new Error(`expected ${code} at ${JSON.stringify(path)}`);
}

/** One valid instance of every kind. Keys deliberately out of order; case deliberately mixed. */
const VALID: Record<string, string> = {
  node_revision: `{"revision_id":"${ID_B}","node_id":"${ID_A}"}`,
  trace: `{"trace_id":"legacy-trace-7"}`,
  message: `{"message_public_id":"${ID_A}","session_name":"s1"}`,
  session: `{"session_name":"s1"}`,
  relic_session: `{"title_snapshot":"Deep research","session_uuid":"c30e0ba2-e0fe-4320-b3ab-3fe6e641dd4e","provider":"claude","source_bank":"peer-projects"}`,
  relic_event: `{"capture_digest":"${DIGEST}","event_seq":"9007199254740993","transcript_ref":"abc.jsonl","session_uuid":"u","provider":"claude","source_bank":"b"}`,
  code: `{"line_end":"210","line_start":"193","path":"app/server/src/db.ts","commit":{"oid":"${SHA1.toUpperCase()}","algorithm":"sha1"},"repo":"Soul-Brews-Studio/Arra-Oracle-V4"}`,
  commit: `{"commit":{"algorithm":"sha256","oid":"${SHA256}"},"repo":"soul-brews-studio/arra-oracle-v4.git"}`,
  issue: `{"url":"https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/23","number":"23","repo":"Soul-Brews-Studio/arra-oracle-v4"}`,
  discussion: `{"comment_id":"18526641","url":"https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/36#discussioncomment-18526641","number":"36","repo":"Soul-Brews-Studio/arra-oracle-v4"}`,
  url: `{"url":"https://Example.test/A?b=1&c=2#Frag"}`,
};

test("all 11 kinds are enumerated once and each VALID sample normalizes with a derivable key", () => {
  expect(([...TARGET_KINDS] as string[]).sort()).toEqual(Object.keys(VALID).sort());
  expect(TARGET_KINDS.length).toBe(11);
  for (const kind of TARGET_KINDS) {
    const r = run(kind, j(VALID[kind]!));
    expect(r.target_key).toMatch(/^[a-f0-9]{64}$/);
    // The key is exactly sha256("arra-target/v1\n" || key_json), recomputed here independently.
    expect(createHash("sha256").update("arra-target/v1\n", "utf8").update(r.key_json, "utf8").digest("hex")).toBe(r.target_key);
    // target_json is canonical: re-parsing and re-running yields identical bytes.
    expect(run(kind, parseStrict(r.target_json)).target_json).toBe(r.target_json);
    // Keys come back in the documented order for that kind.
    expect([...(parseStrict(r.target_json) as Map<string, unknown>).keys()].sort()).toEqual([...TARGET_KEYS[kind]].sort());
  }
});

test("missing, extra and wrong-discriminator payloads reject with closed codes and payload-relative paths", () => {
  expectError(() => run("code", j(`{"repo":"a/b","commit":{"algorithm":"sha1","oid":"${SHA1}"},"path":"x","line_start":null}`)), "missing_field", "/target/line_end");
  expectError(() => run("session", j(`{"session_name":"s1","extra":1}`)), "unexpected_field", "/target/extra");
  expectError(() => run("nope", j(`{"url":"https://a.test/"}`)), "invalid_value", "/target_kind");
  expectError(() => run("url", j(`{"session_name":"s1"}`)), "missing_field", "/target/url");
  expectError(() => run("commit", j(`{"repo":"a/b","commit":{"algorithm":"md5","oid":"${SHA1}"}}`)), "invalid_value", "/target/commit/algorithm");
  expectError(() => targetOp("", "url", j(`{"url":"https://a.test/"}`)), "invalid_value", "/workspace_name");
});

test("repo and OID normalize (lowercase, .git kept) and equivalent spellings produce EQUAL keys", () => {
  const a = run("commit", j(`{"repo":"Soul-Brews-Studio/Arra-Oracle-V4","commit":{"algorithm":"sha1","oid":"${SHA1.toUpperCase()}"}}`));
  const b = run("commit", j(`{"repo":"soul-brews-studio/arra-oracle-v4","commit":{"algorithm":"sha1","oid":"${SHA1}"}}`));
  expect(a.target_key).toBe(b.target_key);
  expect(a.target_json).toBe(`{"commit":{"algorithm":"sha1","oid":"${SHA1}"},"repo":"soul-brews-studio/arra-oracle-v4"}`);
  // .git is a different literal repository name, NOT stripped.
  const c = run("commit", j(`{"repo":"soul-brews-studio/arra-oracle-v4.git","commit":{"algorithm":"sha1","oid":"${SHA1}"}}`));
  expect(c.target_key).not.toBe(b.target_key);
  // sha1 vs sha256 with the same leading hex are different identities.
  const d = run("commit", j(`{"repo":"a/b","commit":{"algorithm":"sha256","oid":"${SHA256}"}}`));
  const e = run("commit", j(`{"repo":"a/b","commit":{"algorithm":"sha1","oid":"${SHA256.slice(0, 40)}"}}`));
  expect(d.target_key).not.toBe(e.target_key);
});

test("repo rejects: wrong segment count, dot segments, non-ASCII, URL and SSH forms", () => {
  for (const repo of ["a", "a/b/c", "./b", "a/..", "a/", "/b", "a b/c", "nazé/x", "https://github.com/a/b", "git@github.com:a/b.git"]) {
    expectError(() => run("commit", j(`{"repo":${JSON.stringify(repo)},"commit":{"algorithm":"sha1","oid":"${SHA1}"}}`)), "invalid_value", "/target/repo");
  }
});

test("OID rejects abbreviated, wrong-length, non-hex and ref names", () => {
  for (const oid of [SHA1.slice(0, 7), SHA1.slice(0, 39), SHA1 + "a", "main", "HEAD", "g".repeat(40)]) {
    expectError(() => run("commit", j(`{"repo":"a/b","commit":{"algorithm":"sha1","oid":${JSON.stringify(oid)}}}`)), "invalid_value", "/target/commit/oid");
  }
  expectError(() => run("commit", j(`{"repo":"a/b","commit":{"algorithm":"sha256","oid":"${SHA1}"}}`)), "invalid_value", "/target/commit/oid");
});

test("code: path rules, line range rules, and distinct ranges give distinct keys", () => {
  const base = (path: string, ls: string, le: string) => `{"repo":"a/b","commit":{"algorithm":"sha1","oid":"${SHA1}"},"path":${JSON.stringify(path)},"line_start":${ls},"line_end":${le}}`;
  expect(run("code", j(base("src/x.ts", "null", "null"))).target_key).toMatch(/^[a-f0-9]{64}$/);
  for (const bad of ["/src/x.ts", "src/x.ts/", "src//x.ts", "src/./x.ts", "src/../x.ts", "src\\x.ts", "src/x\u0000.ts", "src/x\u001f.ts", ""]) {
    expectError(() => run("code", j(base(bad, "null", "null"))), "invalid_value", "/target/path");
  }
  // Path is exact: no casefold, no Unicode normalization.
  expect(run("code", j(base("Src/X.ts", "null", "null"))).target_key).not.toBe(run("code", j(base("src/x.ts", "null", "null"))).target_key);
  expect(run("code", j(base("é.ts", "null", "null"))).target_key).not.toBe(run("code", j(base("é.ts", "null", "null"))).target_key);
  // Lines: both or neither; positive; start <= end; range participates in identity.
  expectError(() => run("code", j(base("x", '"1"', "null"))), "invalid_value", "/target/line_end");
  expectError(() => run("code", j(base("x", '"0"', '"1"'))), "out_of_range", "/target/line_start");
  expectError(() => run("code", j(base("x", '"5"', '"4"'))), "out_of_range", "/target/line_end");
  expectError(() => run("code", j(base("x", "5", "6"))), "invalid_type", "/target/line_start");
  expect(run("code", j(base("x", '"1"', '"2"'))).target_key).not.toBe(run("code", j(base("x", '"1"', '"3"'))).target_key);
  expect(run("code", j(base("x", '"1"', '"2"'))).target_key).not.toBe(run("code", j(base("x", "null", "null"))).target_key);
});

test("relic_event: capture digest and event_seq participate; event_seq keeps values past 2^53 exactly", () => {
  const r = run("relic_event", j(VALID.relic_event!));
  expect(r.target_json).toContain('"event_seq":"9007199254740993"');
  const other = run("relic_event", j(VALID.relic_event!.replace(DIGEST, "0".repeat(64))));
  expect(other.target_key).not.toBe(r.target_key);
  expectError(() => run("relic_event", j(VALID.relic_event!.replace('"9007199254740993"', '"-1"'))), "out_of_range", "/target/event_seq");
  expectError(() => run("relic_event", j(VALID.relic_event!.replace('"9007199254740993"', "5"))), "invalid_type", "/target/event_seq");
  expectError(() => run("relic_event", j(VALID.relic_event!.replace(DIGEST, DIGEST.toUpperCase()))), "invalid_value", "/target/capture_digest");
});

test("display-only fields are ignored by identity: relic_session.title_snapshot, issue/discussion url", () => {
  const s1 = run("relic_session", j(VALID.relic_session!));
  const s2 = run("relic_session", j(VALID.relic_session!.replace('"Deep research"', "null")));
  expect(s1.target_key).toBe(s2.target_key);
  expect(s1.target_json).not.toBe(s2.target_json); // target keeps it; identity drops it
  expect(s1.key_json).not.toContain("title_snapshot");

  const i1 = run("issue", j(VALID.issue!));
  const i2 = run("issue", j(VALID.issue!.replace("issues/23", "issues/23?x=1#frag")));
  expect(i1.target_key).toBe(i2.target_key);
  expect(i1.key_json).not.toContain("url");
  // But the number, repo, and workspace DO participate.
  expect(run("issue", j(VALID.issue!.replace('"23"', '"24"'))).target_key).not.toBe(i1.target_key);
  expect(run("issue", j(VALID.issue!), "other-workspace").target_key).not.toBe(i1.target_key);

  const d1 = run("discussion", j(VALID.discussion!));
  const d2 = run("discussion", j(VALID.discussion!.replace('"18526641"', "null")));
  expect(d1.target_key).not.toBe(d2.target_key); // comment_id is identity
});

test("url: passive WHATWG validation only; original string is preserved and hashed; query/fragment distinct", () => {
  const r = run("url", j(VALID.url!));
  expect(r.target_json).toBe(`{"url":"https://Example.test/A?b=1&c=2#Frag"}`); // NOT lowercased/rewritten
  expect(run("url", j(`{"url":"https://example.test/A?b=1&c=2#Frag"}`)).target_key).not.toBe(r.target_key);
  expect(run("url", j(`{"url":"https://Example.test/A?b=1&c=2"}`)).target_key).not.toBe(r.target_key);
  expect(run("url", j(`{"url":"https://Example.test/A?c=2&b=1#Frag"}`)).target_key).not.toBe(r.target_key);
  for (const bad of ["ftp://a.test/", "javascript:alert(1)", "https://user:pw@a.test/", "https://a.test/ b", " https://a.test/", "https://a.test/ ", "https:\\\\a.test", "https://", "not a url", "https://a.test/\u007f"]) {
    expectError(() => run("url", j(`{"url":${JSON.stringify(bad)}}`)), "invalid_value", "/target/url");
  }
  // Unicode hostnames are accepted when the parser accepts them; the raw spelling is what is kept.
  expect(run("url", j(`{"url":"https://ทดสอบ.ไทย/"}`)).target_json).toBe(`{"url":"https://ทดสอบ.ไทย/"}`);
});

test("verify_target: canonical stored bytes + matching key pass; non-canonical or wrong key reject", () => {
  const r = run("issue", j(VALID.issue!));
  const ok = verifyTargetOp(W, "issue", r.target_json, r.target_key);
  expect(ok).toEqual(r);
  // Stored text that is semantically equal but not canonical (different key order) is rejected.
  const reordered = JSON.stringify(Object.fromEntries([...(parseStrict(r.target_json) as Map<string, unknown>).entries()].reverse()));
  expectError(() => verifyTargetOp(W, "issue", reordered, r.target_key), "invalid_value", "/target_json");
  expectError(() => verifyTargetOp(W, "issue", r.target_json, "0".repeat(64)), "target_key_mismatch", "/target_key");
  expectError(() => verifyTargetOp("other", "issue", r.target_json, r.target_key), "target_key_mismatch", "/target_key");
});

test("no nested workspace override: every target inherits the outer workspace", () => {
  expectError(() => run("session", j(`{"session_name":"s1","workspace_name":"x"}`)), "unexpected_field", "/target/workspace_name");
  expect(run("session", j(`{"session_name":"s1"}`), "A").target_key).not.toBe(run("session", j(`{"session_name":"s1"}`), "B").target_key);
});
