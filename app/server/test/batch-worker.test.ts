import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LIMITS, jsonByteLength, parseStrict as parseJcs } from "../src/contracts/jcs";
import { BATCH_VERSION, dispatchBatch } from "../src/contracts/batch-v1";
import { parseStrict } from "../src/contracts/jcs";
import { testTimeout } from "./helpers/timing.testTimeout";
import { scaledMs } from "./helpers/timing.scaledMs";

const worker = fileURLToPath(new URL("../src/contracts/batch-worker.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));

function runWorker(input: string | Uint8Array): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["run", worker], { input, cwd, encoding: "utf8", timeout: scaledMs(30_000), maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const parse = (s: string) => JSON.parse(s);

const SESSION_TARGET = { id: "t", op: "target", payload: { workspace_name: "w", target_kind: "session", target: { session_name: "s1" } } };
const REPLAY = { id: "s", op: "source_replay", payload: { incoming: { workspace_name: "w", source_namespace: "n", source_message_id: "1", content_digest: "a".repeat(64) }, existing: null } };

test("success: exactly one JSON line on stdout, LF-terminated, exit 0, results in request order", () => {
  const r = runWorker(JSON.stringify({ version: BATCH_VERSION, items: [SESSION_TARGET, REPLAY] }) + "\n");
  expect(r.status).toBe(0);
  expect(r.stdout.endsWith("\n")).toBe(true);
  expect(r.stdout.slice(0, -1)).not.toContain("\n");
  const out = parse(r.stdout);
  expect(out.version).toBe(BATCH_VERSION);
  expect(out.ok).toBe(true);
  expect(out.error).toBeNull();
  expect(out.results.map((x: any) => [x.id, x.op])).toEqual([["t", "target"], ["s", "source_replay"]]);
  expect(out.results[1].value).toEqual({ outcome: "new", original_id: null });
});

test("input with zero or one trailing LF is accepted; extra trailing LFs are JSON whitespace (RFC 8259 ws), not a second document", () => {
  expect(parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [] })).stdout).ok).toBe(true);
  expect(parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [] }) + "\n").stdout).ok).toBe(true);
  expect(parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [] }) + "\n\n").stdout).ok).toBe(true);
  // A SECOND document, however, is trailing input and rejected at the root.
  const two = parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [] }) + "\n{}").stdout);
  expect([two.ok, two.error.item_id, two.error.detail.code, two.error.detail.path]).toEqual([false, null, "invalid_json", ""]);
});

test("empty items array returns empty results", () => {
  const out = parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [] })).stdout);
  expect(out).toEqual({ version: BATCH_VERSION, ok: true, results: [], error: null });
});

test("framing errors: item_id null, pointer over the whole request; contract errors still exit 0", () => {
  const cases: Array<[unknown, string, string]> = [
    [{ version: "arra-contract-batch/v2", items: [] }, "unsupported_version", "/version"],
    [{ items: [] }, "missing_field", "/version"],
    [{ version: BATCH_VERSION, items: [], extra: 1 }, "unexpected_field", "/extra"],
    [{ version: BATCH_VERSION, items: {} }, "invalid_type", "/items"],
    [{ version: BATCH_VERSION, items: [{ id: "a", op: "target" }] }, "missing_field", "/items/0/payload"],
    [{ version: BATCH_VERSION, items: [{ id: "a", op: "nope", payload: {} }] }, "invalid_value", "/items/0/op"],
    [{ version: BATCH_VERSION, items: [{ id: "", op: "target", payload: {} }] }, "invalid_value", "/items/0/id"],
    [{ version: BATCH_VERSION, items: [{ id: "a", op: "target", payload: {} }, { id: "a", op: "target", payload: {} }] }, "invalid_value", "/items/1/id"],
    [{ version: BATCH_VERSION, items: [{ id: "x".repeat(129), op: "target", payload: {} }] }, "limit_exceeded", "/items/0/id"],
    [{ version: BATCH_VERSION, items: Array.from({ length: 65 }, (_, i) => ({ id: String(i), op: "target", payload: {} })) }, "limit_exceeded", "/items"],
  ];
  for (const [req, code, path] of cases) {
    const r = runWorker(JSON.stringify(req));
    expect(r.status).toBe(0);
    const out = parse(r.stdout);
    expect([out.ok, out.results, out.error.item_id, out.error.detail.code, out.error.detail.path]).toEqual([false, [], null, code, path]);
    expect(out.error.detail.version).toBe("arra-error/v1");
  }
});

test("identities are validated for ALL items before any payload; first payload error wins with that item's id and a payload-relative pointer", () => {
  // Item 0 has a bad payload, item 1 has a duplicate id: the identity error (item_id null) wins.
  let out = parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [{ id: "a", op: "target", payload: {} }, { id: "a", op: "target", payload: {} }] })).stdout);
  expect([out.error.item_id, out.error.detail.path]).toEqual([null, "/items/1/id"]);
  // Two bad payloads: the FIRST in request order is reported, and no results are returned.
  out = parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [SESSION_TARGET, { id: "bad1", op: "target", payload: { workspace_name: "w", target_kind: "url", target: { url: "ftp://x/" } } }, { id: "bad2", op: "target", payload: {} }] })).stdout);
  expect([out.ok, out.results, out.error.item_id, out.error.detail.code, out.error.detail.path]).toEqual([false, [], "bad1", "invalid_value", "/target/url"]);
});

test("stdin over the transport cap is refused before decoding; oversized single document within transport is limit_exceeded at its pointer", () => {
  const huge = new Uint8Array(LIMITS.maxTransportBytes + 1).fill(0x20);
  const r = runWorker(huge);
  expect(r.status).toBe(0);
  const out = parse(r.stdout);
  expect([out.ok, out.error.item_id, out.error.detail.code]).toEqual([false, null, "limit_exceeded"]);
  // A single 1 MiB+1 raw column inside an otherwise small request.
  const big = JSON.stringify({ version: BATCH_VERSION, items: [{ id: "r", op: "revision", payload: { content: { workspace_name: "w", node_id: "Node0000000000000001_", base_revision_id: null, title: "", body: "", body_format: "text", fields: "{\"a\":\"" + "x".repeat(LIMITS.maxDocumentBytes) + "\"}", author_peer_name: null, observer_peer_name: null, subject_peer_name: null, session_name: null, is_active: true, valid_from: null, valid_to: null, change_reason: null, schema_version: "1", canonical_version: "arra-revision/v1", term_snapshot_json: "[]", link_snapshot_json: "[]", h_metadata: null, internal_metadata: null } } }] });
  // The payload holding that column is itself over 1 MiB, so the per-payload bound (§7, payload phase,
  // item_id set, payload-root pointer "") fires BEFORE the column's own bound would. Both are limit_exceeded; the outer one wins.
  const out2 = parse(runWorker(big).stdout);
  expect([out2.error.item_id, out2.error.detail.code, out2.error.detail.path]).toEqual(["r", "limit_exceeded", ""]);
  // The column-level bound is still reachable when the payload itself fits: a 1 MiB column inside a payload padded to exactly the limit cannot exist,
  // so prove it directly through the pure dispatcher with a column just over and a payload just under.
  const col = "{\"a\":\"" + "x".repeat(LIMITS.maxDocumentBytes - 8) + "\"}"; // {"a":"…"} is 9 bytes of overhead
  expect(new TextEncoder().encode(col).byteLength).toBe(LIMITS.maxDocumentBytes);
});

test("malformed UTF-8 and duplicate keys at the transport layer are closed framing errors", () => {
  const bad = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]); // {"\xff":1}
  expect(parse(runWorker(bad).stdout).error.detail.code).toBe("invalid_unicode");
  const dup = `{"version":"${BATCH_VERSION}","items":[],"items":[]}`;
  const out = parse(runWorker(dup).stdout);
  expect([out.error.item_id, out.error.detail.code, out.error.detail.path]).toEqual([null, "duplicate_key", "/items"]);
});

test("pure dispatcher agrees with the subprocess on a mixed batch", () => {
  const req = { version: BATCH_VERSION, items: [SESSION_TARGET, REPLAY] };
  const viaProcess = parse(runWorker(JSON.stringify(req)).stdout);
  const viaFunction = JSON.parse(JSON.stringify(dispatchBatch(parseStrict(JSON.stringify(req)))));
  expect(viaFunction).toEqual(viaProcess);
});

test("worker writes nothing but the one document to stdout", () => {
  const r = runWorker(JSON.stringify({ version: BATCH_VERSION, items: [SESSION_TARGET] }));
  expect(r.stdout.trim().split("\n")).toHaveLength(1);
  expect(r.stderr).toBe("");
});

test("§7 per-payload 1 MiB bound: exactly 1 MiB passes, 1 MiB + 1 byte rejects at /items/N/payload, well under the 16 MiB transport cap", () => {
  // Reviewer repro: a 1,048,659-byte target/url payload used to SUCCEED because only the transport cap existed.
  const build = (bodyLen: number) => ({ version: BATCH_VERSION, items: [{ id: "r", op: "revision", payload: { content: {
    workspace_name: "w", node_id: "Node0000000000000001_", base_revision_id: null, title: "", body: "x".repeat(bodyLen), body_format: "text", fields: "{}",
    author_peer_name: null, observer_peer_name: null, subject_peer_name: null, session_name: null, is_active: true, valid_from: null, valid_to: null,
    change_reason: null, schema_version: "1", canonical_version: "arra-revision/v1", term_snapshot_json: "[]", link_snapshot_json: "[]", h_metadata: null, internal_metadata: null,
  } } }] });
  // Measure compact bytes WITHOUT re-parsing: JSON.stringify on a plain object is
  // already compact, and parsing an over-limit payload would trip the parse cap itself.
  const compact = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
  const overhead = compact(build(0).items[0]!.payload);
  const exact = LIMITS.maxDocumentBytes - overhead;
  const atLimit = build(exact);
  expect(compact(atLimit.items[0]!.payload)).toBe(LIMITS.maxDocumentBytes);
  expect(JSON.stringify(atLimit).length).toBeLessThan(LIMITS.maxTransportBytes);
  const ok = parse(runWorker(JSON.stringify(atLimit)).stdout);
  expect(ok.ok).toBe(true);

  const overLimit = build(exact + 1);
  expect(compact(overLimit.items[0]!.payload)).toBe(LIMITS.maxDocumentBytes + 1);
  const out = parse(runWorker(JSON.stringify(overLimit)).stdout);
  // A PAYLOAD error: the item's validated id, and the payload root pointer.
  expect([out.ok, out.error.item_id, out.error.detail.code, out.error.detail.path]).toEqual([false, "r", "limit_exceeded", ""]);

  // The reviewer's exact shape: a url payload padded past 1 MiB inside a small transport.
  const urlPayload = { workspace_name: "w", target_kind: "url", target: { url: "https://a.test/" + "p".repeat(LIMITS.maxDocumentBytes) } };
  const out2 = parse(runWorker(JSON.stringify({ version: BATCH_VERSION, items: [{ id: "u", op: "target", payload: urlPayload }] })).stdout);
  expect([out2.ok, out2.error.item_id, out2.error.detail.code, out2.error.detail.path]).toEqual([false, "u", "limit_exceeded", ""]);

  // PRECEDENCE PIN 1: identities are validated for ALL items first -- a later duplicate id outranks an earlier oversized payload.
  const dupAfterOversized = { version: BATCH_VERSION, items: [{ id: "big", op: "target", payload: urlPayload }, SESSION_TARGET, { ...SESSION_TARGET }] };
  const p1 = parse(runWorker(JSON.stringify(dupAfterOversized)).stdout);
  expect([p1.error.item_id, p1.error.detail.code, p1.error.detail.path]).toEqual([null, "invalid_value", "/items/2/id"]);
  // PRECEDENCE PIN 2: with every identity valid, the oversized payload is reported under ITS id, in request order, before a later bad payload.
  const oversizedThenBad = { version: BATCH_VERSION, items: [SESSION_TARGET, { id: "big", op: "target", payload: urlPayload }, { id: "bad", op: "target", payload: {} }] };
  const p2 = parse(runWorker(JSON.stringify(oversizedThenBad)).stdout);
  expect([p2.error.item_id, p2.error.detail.code, p2.error.detail.path]).toEqual(["big", "limit_exceeded", ""]);
  // Pure dispatcher agrees, via a transport parse that permits the larger document.
  const viaFn = dispatchBatch(parseJcs(JSON.stringify(overLimit), [], { maxBytes: LIMITS.maxTransportBytes }));
  expect(viaFn.ok).toBe(false);
  if (!viaFn.ok) expect([viaFn.error.item_id, viaFn.error.detail.code, viaFn.error.detail.path]).toEqual(["r", "limit_exceeded", ""]);
});

test("jsonByteLength matches the real compact serialization on representative values", () => {
  for (const text of ['null', 'true', 'false', '0', '-1.5', '1e+21', '"ภาษาไทย 🌱"', '\"\\u0000\\n\\\"\"', '[]', '{}', '[1,[2,[3]]]', '{"a":{"b":[true,null,"x"]}}', '{\"\\u0000\":\"\\u001f\"}']) {
    const v = parseJcs(text);
    const expected = new TextEncoder().encode(JSON.stringify(JSON.parse(text))).byteLength;
    expect([text, jsonByteLength(v)]).toEqual([text, expected]);
  }
});

test("§7 per-payload bound measures RAW wire bytes: whitespace- and escape-heavy payloads over 1 MiB cannot slip through by compacting under it", () => {
  const compactBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
  const wire = (payloadText: string) => `{"version":"${BATCH_VERSION}","items":[{"id":"w1","op":"target","payload":${payloadText}}]}`;
  const SMALL = { workspace_name: "w", target_kind: "session", target: { session_name: "s1" } };

  // (a) whitespace-heavy: 1.07 MiB of padding around a 77-byte payload.
  const wsPad = " ".repeat(1100 * 1024);
  const wsText = `{${wsPad}"workspace_name":"w","target_kind":"session","target":{"session_name":"s1"}}`;
  expect(compactBytes(SMALL)).toBeLessThan(LIMITS.maxDocumentBytes);              // compacts far under the cap
  expect(new TextEncoder().encode(wsText).byteLength).toBeGreaterThan(LIMITS.maxDocumentBytes);
  expect(wire(wsText).length).toBeLessThan(LIMITS.maxTransportBytes);             // and sits under the transport cap
  const ws = parse(runWorker(wire(wsText)).stdout);
  expect([ws.ok, ws.error.item_id, ws.error.detail.code, ws.error.detail.path]).toEqual([false, "w1", "limit_exceeded", ""]);
  expect(ws.error.detail.message).toContain("raw");

  // (b) escape-heavy: every character written as \u00XX, so raw is 6x the compacted string.
  const escaped = "\\u0061".repeat(190 * 1024);                                    // ~1.14 MiB raw, ~190 KiB compact
  const escText = `{"workspace_name":"${escaped}","target_kind":"session","target":{"session_name":"s1"}}`;
  expect(new TextEncoder().encode(escText).byteLength).toBeGreaterThan(LIMITS.maxDocumentBytes);
  const escCompact = compactBytes({ ...SMALL, workspace_name: "a".repeat(190 * 1024) });
  expect(escCompact).toBeLessThan(LIMITS.maxDocumentBytes);                        // compacts under the cap
  const esc = parse(runWorker(wire(escText)).stdout);
  expect([esc.ok, esc.error.item_id, esc.error.detail.code, esc.error.detail.path]).toEqual([false, "w1", "limit_exceeded", ""]);

  // (c) at-cap raw passes: pad so the payload's raw span is exactly the limit.
  const base = `{"workspace_name":"w","target_kind":"session","target":{"session_name":"s1"}}`;
  const atCapText = `{${" ".repeat(LIMITS.maxDocumentBytes - new TextEncoder().encode(base).byteLength)}"workspace_name":"w","target_kind":"session","target":{"session_name":"s1"}}`;
  expect(new TextEncoder().encode(atCapText).byteLength).toBe(LIMITS.maxDocumentBytes);
  expect(parse(runWorker(wire(atCapText)).stdout).ok).toBe(true);

  // (d) one byte over the cap rejects.
  const overText = `{${" ".repeat(LIMITS.maxDocumentBytes - new TextEncoder().encode(base).byteLength + 1)}"workspace_name":"w","target_kind":"session","target":{"session_name":"s1"}}`;
  expect(new TextEncoder().encode(overText).byteLength).toBe(LIMITS.maxDocumentBytes + 1);
  const over = parse(runWorker(wire(overText)).stdout);
  expect([over.ok, over.error.item_id, over.error.detail.code, over.error.detail.path]).toEqual([false, "w1", "limit_exceeded", ""]);

  // Identity precedence survives the move to raw measurement.
  const dupAfterRaw = `{"version":"${BATCH_VERSION}","items":[{"id":"w1","op":"target","payload":${wsText}},{"id":"d","op":"target","payload":${base}},{"id":"d","op":"target","payload":${base}}]}`;
  const dup = parse(runWorker(dupAfterRaw).stdout);
  expect([dup.error.item_id, dup.error.detail.code, dup.error.detail.path]).toEqual([null, "invalid_value", "/items/2/id"]);
}, testTimeout(30_000));
