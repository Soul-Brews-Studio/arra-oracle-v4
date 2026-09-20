import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContractError } from "../src/contracts/errors";
import { obj, parseStrict, type JcsObject, type JcsValue } from "../src/contracts/jcs";
import { ENVELOPE_KEYS, revisionOp, termProjection, verifyRevisionOp } from "../src/contracts/revision-v1";
import { targetOp } from "../src/contracts/evidence-v1";

const kaPath = fileURLToPath(new URL("../../migrate-py/tests/fixtures/revision-v1/revision-known-answer.json", import.meta.url));
const KA = JSON.parse(await readFile(kaPath, "utf8"));

/** Build a Map envelope from a plain record (test convenience; the worker path parses text). */
function env(overrides: Record<string, JcsValue> = {}): JcsObject {
  const base: Record<string, JcsValue> = { ...KA.revision.input_content, ...overrides };
  return obj(base);
}
function expectError(fn: () => unknown, code: string, path: string) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect([(error as ContractError).code, (error as ContractError).path]).toEqual([code, path]);
    return;
  }
  throw new Error(`expected ${code} at ${JSON.stringify(path)}`);
}
const digestOf = (canonical: string) => createHash("sha256").update("arra-revision/v1\n", "utf8").update(canonical, "utf8").digest("hex");

test("known answer: hand-authored canonical bytes, digest, and normalized columns match exactly", () => {
  const r = revisionOp(env());
  expect(r.canonical_json).toBe(KA.revision.expected.canonical_json);
  expect(r.content_digest).toBe(KA.revision.expected.content_digest);
  expect(r.columns).toEqual(KA.revision.expected.columns);
  expect(digestOf(r.canonical_json)).toBe(r.content_digest);
  // 21 envelope keys, terms/links replace the two *_snapshot_json keys, nested JSON hashed as VALUES.
  const logical = parseStrict(r.canonical_json) as JcsObject;
  expect(logical.size).toBe(21);
  expect(logical.has("terms") && logical.has("links")).toBe(true);
  expect(logical.has("term_snapshot_json") || logical.has("link_snapshot_json")).toBe(false);
  expect(logical.get("fields")).toBeInstanceOf(Map);
  expect(r.canonical_json).not.toContain('"{'); // no double-encoded JSON strings
  expect(ENVELOPE_KEYS.length).toBe(21);
});

test("shuffled snapshot key order and input position order canonicalize to the same bytes", () => {
  const r0 = revisionOp(env());
  const reorderedTerms = '[{"label_snapshot":"Conclusion","position":"0","term_id":"Term0000000000000001_","term_name_snapshot":"conclusion","vocabulary_id":"Vocb0000000000000001_","vocabulary_name_snapshot":"type"},{"vocabulary_name_snapshot":"topics","vocabulary_id":"Vocb0000000000000001_","term_name_snapshot":"schema","term_id":"Term0000000000000002_","position":"1","label_snapshot":null}]';
  const r1 = revisionOp(env({ term_snapshot_json: reorderedTerms }));
  expect(r1.canonical_json).toBe(r0.canonical_json);
  expect(r1.content_digest).toBe(r0.content_digest);
});

test("equivalent raw spellings converge: number forms, -0, whitespace, key order in fields/metadata", () => {
  const r0 = revisionOp(env());
  for (const fields of ['{"a":1.5,"b":2}', '{ "b" : 2.0 , "a" : 15e-1 }', '{"a":1.50,"b":2}', '{"b":2,"a":0.15e1}']) {
    expect(revisionOp(env({ fields })).content_digest).toBe(r0.content_digest);
  }
  expect(revisionOp(env({ fields: '{"a":1.5,"b":2,"z":-0}' })).columns.fields).toBe('{"a":1.5,"b":2,"z":0}');
  expect(revisionOp(env({ internal_metadata: '{ "k":"v" }' })).content_digest).toBe(r0.content_digest);
});

test("one independently varied VALID value per governed category changes the digest", () => {
  const base = revisionOp(env()).content_digest;
  const variants: Array<[string, Record<string, JcsValue>]> = [
    ["title", { title: "T2" }],
    ["body", { body: "B2" }],
    ["body_format", { body_format: "markdown" }],
    ["fields", { fields: '{"a":1.5,"b":3}' }],
    ["author", { author_peer_name: "nat" }],
    ["observer", { observer_peer_name: "neo" }],
    ["subject", { subject_peer_name: null }],
    ["session", { session_name: "s9" }],
    ["is_active", { is_active: false }],
    ["valid_from", { valid_from: null }],
    ["valid_to", { valid_to: "2026-09-20T00:00:00.000Z" }],
    ["change_reason", { change_reason: "why" }],
    ["base_revision_id", { base_revision_id: "Revn0000000000000009_" }],
    ["node_id", { node_id: "Node0000000000000002_" }],
    ["workspace_name", { workspace_name: "w2" }],
    ["term label", { term_snapshot_json: KA.revision.input_content.term_snapshot_json.replace('"Conclusion"', '"Conclusion!"') }],
    ["term name", { term_snapshot_json: KA.revision.input_content.term_snapshot_json.replace('"schema"', '"schemas"') }],
    ["term set", { term_snapshot_json: "[]" }],
    ["link relation", { link_snapshot_json: KA.revision.input_content.link_snapshot_json.replace('"supports"', '"contradicts"') }],
    ["link target", { link_snapshot_json: KA.revision.input_content.link_snapshot_json.replace('"s1"', '"s2"') }],
    ["link capture_status", { link_snapshot_json: KA.revision.input_content.link_snapshot_json.replace('"locator_only"', '"unresolved"') }],
    ["link excerpt", { link_snapshot_json: KA.revision.input_content.link_snapshot_json.replace('"excerpt":null', '"excerpt":"quoted"') }],
    ["link note", { link_snapshot_json: KA.revision.input_content.link_snapshot_json.replace('"note":null', '"note":"n"') }],
    ["h_metadata", { h_metadata: "{}" }],
    ["internal_metadata", { internal_metadata: '{"k":"w"}' }],
  ];
  const seen = new Set<string>([base]);
  for (const [label, override] of variants) {
    const d = revisionOp(env(override)).content_digest;
    expect([label, d === base]).toEqual([label, false]);
    seen.add(d);
  }
  expect(seen.size).toBe(variants.length + 1); // all distinct from each other too
});

test("snapshot positions: gaps, duplicates, non-contiguous, negative and non-string all reject with snapshot_position or a closed code", () => {
  const term = (pos: string, id = "Term0000000000000001_") => `{"term_id":"${id}","vocabulary_id":"Vocb0000000000000001_","vocabulary_name_snapshot":"type","term_name_snapshot":"x","label_snapshot":null,"position":${pos}}`;
  expectError(() => revisionOp(env({ term_snapshot_json: `[${term('"1"')}]` })), "snapshot_position", "/term_snapshot_json/0/position");
  expectError(() => revisionOp(env({ term_snapshot_json: `[${term('"0"')},${term('"0"', "Term0000000000000002_")}]` })), "snapshot_position", "/term_snapshot_json/1/position");
  expectError(() => revisionOp(env({ term_snapshot_json: `[${term('"0"')},${term('"2"', "Term0000000000000002_")}]` })), "snapshot_position", "/term_snapshot_json/1/position");
  expectError(() => revisionOp(env({ term_snapshot_json: `[${term('"-1"')}]` })), "out_of_range", "/term_snapshot_json/0/position");
  expectError(() => revisionOp(env({ term_snapshot_json: `[${term("0")}]` })), "invalid_type", "/term_snapshot_json/0/position");
  // Duplicate term_id at distinct positions.
  expectError(() => revisionOp(env({ term_snapshot_json: `[${term('"0"')},${term('"1"')}]` })), "invalid_value", "/term_snapshot_json/1/term_id");
  // Missing snapshot field.
  expectError(() => revisionOp(env({ term_snapshot_json: `[{"term_id":"Term0000000000000001_","position":"0"}]` })), "missing_field", "/term_snapshot_json/0/vocabulary_id");
  // Repeated targets/relations at distinct positions are allowed.
  const link = (pos: string) => `{"position":"${pos}","relation":"supports","target_kind":"session","target":{"session_name":"s1"},"excerpt":null,"content_hash":null,"captured_at":null,"capture_status":"locator_only","note":null}`;
  expect(revisionOp(env({ link_snapshot_json: `[${link("0")},${link("1")}]` })).columns.link_snapshot_json).toContain('"position":"1"');
});

test("closed envelope: allocation fields are UNEXPECTED, missing keys reject, unsupported versions reject", () => {
  for (const k of ["id", "revision_no", "operation_id", "created_at", "content_digest", "current_revision_id"]) {
    expectError(() => revisionOp(env({ [k]: "x" })), "unexpected_field", `/${k}`);
  }
  const m = env(); m.delete("title");
  expectError(() => revisionOp(m), "missing_field", "/title");
  expectError(() => revisionOp(env({ schema_version: "2" })), "unsupported_version", "/schema_version");
  expectError(() => revisionOp(env({ schema_version: 1 })), "invalid_type", "/schema_version");
  expectError(() => revisionOp(env({ canonical_version: "arra-revision/v2" })), "unsupported_version", "/canonical_version");
  expectError(() => revisionOp(env({ body_format: "html" })), "invalid_value", "/body_format");
  expectError(() => revisionOp(env({ is_active: "true" })), "invalid_type", "/is_active");
  expectError(() => revisionOp(env({ author_peer_name: "" })), "invalid_value", "/author_peer_name");
  expectError(() => revisionOp(env({ valid_from: "2026-09-18T03:39:42Z" })), "invalid_value", "/valid_from");
  expectError(() => revisionOp(env({ fields: "[]" })), "invalid_type", "/fields");
  expectError(() => revisionOp(env({ fields: '{"a":1,"a":2}' })), "duplicate_key", "/fields/a");
  expectError(() => revisionOp(env({ internal_metadata: '{"n":1e999}' })), "invalid_value", "/internal_metadata/n");
});

test("link content_hash/captured_at shape only: a well-formed captured claim is accepted without any fetch or hash check", () => {
  const link = `[{"position":"0","relation":"supports","target_kind":"url","target":{"url":"https://a.test/x"},"excerpt":"quoted text","content_hash":"${"0".repeat(64)}","captured_at":"2026-09-20T10:00:00.000Z","capture_status":"captured","note":null}]`;
  const r = revisionOp(env({ link_snapshot_json: link }));
  expect(r.columns.link_snapshot_json).toContain('"capture_status":"captured"');
  // Shape is validated; truth of the capture is NOT. Bad shapes still reject.
  expectError(() => revisionOp(env({ link_snapshot_json: link.replace("0".repeat(64), "abc") })), "invalid_value", "/link_snapshot_json/0/content_hash");
  expectError(() => revisionOp(env({ link_snapshot_json: link.replace("captured_at\":\"2026-09-20T10:00:00.000Z", "captured_at\":\"soon") })), "invalid_value", "/link_snapshot_json/0/captured_at");
});

test("verify_revision: canonical stored columns + matching digest pass; non-canonical stored column or wrong digest reject", () => {
  const r = revisionOp(env());
  const stored = env({ ...r.columns });
  expect(verifyRevisionOp(stored, r.content_digest)).toEqual(r);
  // Raw (non-canonical) fields text on a stored row is rejected even though it is semantically equal.
  expectError(() => verifyRevisionOp(env({ ...r.columns, fields: '{"b":2,"a":1.5}' }), r.content_digest), "invalid_value", "/content/fields");
  expectError(() => verifyRevisionOp(stored, "0".repeat(64)), "digest_mismatch", "/content_digest");
  expectError(() => verifyRevisionOp(stored, "not-hex"), "invalid_value", "/content_digest");
});

test("derived projections are mechanical from the NORMALIZED snapshot and carry no id", () => {
  const r = revisionOp(env());
  const terms = parseStrict(r.columns.term_snapshot_json) as JcsObject[];
  const rows = termProjection("w", "Revn0000000000000001_", terms);
  expect(rows.map((m) => [...m.keys()])).toEqual(rows.map(() => ["workspace_name", "revision_id", "term_id", "vocabulary_id", "vocabulary_name_snapshot", "term_name_snapshot", "label_snapshot", "position"]));
  expect(rows.map((m) => m.get("position"))).toEqual(["0", "1"]);
  // Link projection composition: target op on the normalized link target yields target_json equal to the snapshot entry.
  const links = parseStrict(r.columns.link_snapshot_json) as JcsObject[];
  const t = targetOp("w", links[0]!.get("target_kind")!, links[0]!.get("target")!);
  expect(parseStrict(t.target_json)).toEqual(links[0]!.get("target")!);
  expect(r.columns.link_snapshot_json).not.toContain("target_key"); // derived, never in the snapshot
});
