/**
 * Gate 7: Python persists full target rows carrying REAL canonical JSON,
 * snapshots, digests and target keys into scratch LanceDB tables; Bun reopens
 * them and verifies every stored byte through the contract; exactly-mutated
 * stored bytes reject.
 *
 * The exporter never starts Bun -- the values were baked into sample-rows.json
 * by the worker beforehand, so schema-only Python paths stay Bun-free.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import { ContractError } from "../src/contracts/errors";
import { obj, parseStrict, type JcsObject, type JcsValue } from "../src/contracts/jcs";
import { ENVELOPE_KEYS, revisionOp, verifyRevisionOp, termProjection } from "../src/contracts/revision-v1";
import { targetOp, verifyTargetOp } from "../src/contracts/evidence-v1";
import { formatTimestamp } from "../src/contracts/v1";

const python = process.env.ARRA_CONTRACT_PYTHON ?? fileURLToPath(new URL("../../migrate-py/.venv/bin/python", import.meta.url));
const exporter = fileURLToPath(new URL("../../migrate-py/tests/export_target_schema_fixture.py", import.meta.url));
const source = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));
const samplePath = fileURLToPath(new URL("../../migrate-py/tests/fixtures/target-v1/sample-rows.json", import.meta.url));

/**
 * Read a timestamp[us] cell as its RAW Int64 microseconds. Arrow JS's row
 * accessor divides by 1000 into a Number, which silently drops sub-millisecond
 * precision (1758166782000001 -> 1758166782000.001) and, for far dates, lands
 * on an INTEGER (253402300799999001 -> 253402300799999) so no post-hoc
 * Number.isInteger check can recover it. Only the underlying BigInt64Array is
 * exact. Measured; see the negative test below.
 */
function rawTimestampMicros(column: any, rowIndex: number): bigint | null {
  if (!column.isValid(rowIndex)) return null;
  let offset = 0;
  for (const chunk of column.data) {
    if (rowIndex < offset + chunk.length) {
      const values = chunk.values as BigInt64Array;
      return values[chunk.offset + (rowIndex - offset)]!;
    }
    offset += chunk.length;
  }
  throw new Error(`row ${rowIndex} beyond column length ${column.length}`);
}

/** Fixture read adapter: exact-ms only. Sub-millisecond storage is a REJECTION, never a rounding. */
function timestampTextFromRaw(micros: bigint | null, where: string): string | null {
  if (micros === null) return null;
  if (micros % 1000n !== 0n) throw new ContractError("out_of_range", where, `stored timestamp ${micros}us is not millisecond-exact; refusing to round`);
  const ms = micros / 1000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER) || ms < -BigInt(Number.MAX_SAFE_INTEGER)) throw new ContractError("out_of_range", where, "stored timestamp outside the safe millisecond range");
  return formatTimestamp(new Date(Number(ms)));
}

/**
 * Rebuild the 21-key raw content envelope from a STORED physical row, read
 * through the Arrow table so timestamps come from raw microseconds. Allocation
 * fields are dropped here, at the adapter boundary.
 */
function contentFromArrowRow(arrow: any, i: number): JcsObject {
  const cell = (name: string): JcsValue => {
    const v = arrow.getChild(name)!.get(i);
    return v === undefined ? null : (v as JcsValue);
  };
  const m: Record<string, JcsValue> = {
    workspace_name: cell("workspace_name"), node_id: cell("node_id"), base_revision_id: cell("base_revision_id"),
    title: cell("title"), body: cell("body"), body_format: cell("body_format"), fields: cell("fields"),
    author_peer_name: cell("author_peer_name"), observer_peer_name: cell("observer_peer_name"),
    subject_peer_name: cell("subject_peer_name"), session_name: cell("session_name"),
    is_active: cell("is_active"),
    valid_from: timestampTextFromRaw(rawTimestampMicros(arrow.getChild("valid_from"), i), "/valid_from"),
    valid_to: timestampTextFromRaw(rawTimestampMicros(arrow.getChild("valid_to"), i), "/valid_to"),
    change_reason: cell("change_reason"), schema_version: String(arrow.getChild("schema_version")!.get(i)),
    canonical_version: cell("canonical_version"), term_snapshot_json: cell("term_snapshot_json"),
    link_snapshot_json: cell("link_snapshot_json"), h_metadata: cell("h_metadata"), internal_metadata: cell("internal_metadata"),
  };
  const out = obj(m);
  expect([...out.keys()].sort()).toEqual([...ENVELOPE_KEYS].sort());
  return out;
}
function expectError(fn: () => unknown, code: string, path: string) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect([(error as ContractError).code, (error as ContractError).path]).toEqual([code, path]);
    return;
  }
  throw new Error(`expected ${code} at ${JSON.stringify(path)}`);
}

test("Python-persisted revisions and links verify byte-for-byte in Bun; single stored-byte mutations reject", async () => {
  const samples = JSON.parse(await readFile(samplePath, "utf8")) as { tables: Record<string, any[]> };
  const root = await mkdtemp(join(tmpdir(), "arra-revision-persisted-"));
  try {
    const exp = spawnSync(python, [exporter, root], { encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONPATH: source } });
    if (exp.error) throw new Error(`Python fixture unavailable: ${exp.error.message}`);
    expect(exp.status).toBe(0);
    const db = await connect(join(root, "target-v1-lancedb"));
    try {
      // ---- node_revisions: every stored row re-verifies against its own stored digest ----
      const revTable = await db.openTable("node_revisions");
      const revArrow = await revTable.toArrow();
      const revisions = await revTable.query().toArray();
      expect(revisions.length).toBe(samples.tables.node_revisions.length);
      expect(revArrow.numRows).toBe(revisions.length);
      const contentAt = (row: any) => contentFromArrowRow(revArrow, revisions.indexOf(row));
      for (const row of revisions) {
        const content = contentAt(row);
        const verified = verifyRevisionOp(content, row.content_digest);
        expect(verified.content_digest).toBe(row.content_digest);
        // Stored columns ARE the normalized columns -- what was hashed is what was persisted.
        expect(verified.columns).toEqual({ fields: row.fields, term_snapshot_json: row.term_snapshot_json, link_snapshot_json: row.link_snapshot_json, h_metadata: row.h_metadata, internal_metadata: row.internal_metadata });
        // No stored snapshot carries a derived target_key.
        expect(row.link_snapshot_json).not.toContain("target_key");
      }
      const empty = revisions.find((r: any) => r.term_snapshot_json === "[]")!;
      const full = revisions.find((r: any) => r.term_snapshot_json !== "[]")!;
      expect(empty.link_snapshot_json).toBe("[]"); // empty is the explicit string, and it hashed

      // ---- exactly one stored byte mutated -> reject, with the pointer naming the column ----
      const c = contentAt(full);
      const mut = (k: string, v: JcsValue) => { const m = new Map(c); m.set(k, v); return m; };
      expectError(() => verifyRevisionOp(mut("body", full.body + " "), full.content_digest), "digest_mismatch", "/content_digest");
      expectError(() => verifyRevisionOp(mut("term_snapshot_json", full.term_snapshot_json.replace('"position":"0"', '"position":"0" ')), full.content_digest), "invalid_value", "/content/term_snapshot_json");
      expectError(() => verifyRevisionOp(mut("fields", '{"k":"v" }'), full.content_digest), "invalid_value", "/content/fields");
      expectError(() => verifyRevisionOp(c, full.content_digest.replace(/.$/, (ch: string) => (ch === "0" ? "1" : "0"))), "digest_mismatch", "/content_digest");
      expectError(() => verifyRevisionOp(mut("is_active", !full.is_active), full.content_digest), "digest_mismatch", "/content_digest");
      expectError(() => verifyRevisionOp(mut("internal_metadata", full.internal_metadata.replace("nat", "neo")), full.content_digest), "digest_mismatch", "/content_digest");

      // ---- revision_links: stored target_json + target_key verify; projection equals the normalized snapshot entry ----
      const links = await (await db.openTable("revision_links")).query().toArray();
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        const v = verifyTargetOp(link.workspace_name, link.target_kind, link.target, link.target_key);
        expect(v.target_key).toBe(link.target_key);
        // The owning revision's snapshot entry at this position must equal the projection.
        const owner = revisions.find((r: any) => r.id === link.revision_id)!;
        const snapshot = parseStrict(owner.link_snapshot_json) as JcsObject[];
        const entry = snapshot.find((e) => e.get("position") === String(link.position))!;
        expect(entry).toBeDefined();
        expect(parseStrict(link.target)).toEqual(entry.get("target")!);
        expect(link.relation).toBe(entry.get("relation"));
        expect(link.capture_status).toBe(entry.get("capture_status"));
        // Composition rule: target op on the normalized snapshot target reproduces the stored projection bytes.
        const again = targetOp(link.workspace_name, link.target_kind, entry.get("target")!);
        expect([again.target_json, again.target_key]).toEqual([link.target, link.target_key]);
        // Mutations: non-canonical stored target, wrong key, wrong workspace.
        expectError(() => verifyTargetOp(link.workspace_name, link.target_kind, link.target.replace("}", " }"), link.target_key), "invalid_value", "/target_json");
        expectError(() => verifyTargetOp(link.workspace_name, link.target_kind, link.target, "f".repeat(64)), "target_key_mismatch", "/target_key");
        expectError(() => verifyTargetOp("other", link.target_kind, link.target, link.target_key), "target_key_mismatch", "/target_key");
      }

      // ---- node_revision_terms: stored projection rows equal the mechanical projection of the stored snapshot ----
      const termRows = await (await db.openTable("node_revision_terms")).query().toArray();
      for (const t of termRows) {
        const owner = revisions.find((r: any) => r.id === t.revision_id)!;
        const projected = termProjection(owner.workspace_name, owner.id, parseStrict(owner.term_snapshot_json) as JcsObject[]);
        const match = projected.find((p) => p.get("term_id") === t.term_id)!;
        expect(match).toBeDefined();
        expect(String(t.position)).toBe(match.get("position") as string);
        expect(t.vocabulary_name_snapshot).toBe(match.get("vocabulary_name_snapshot"));
      }
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("re-running the revision op on stored content reproduces the stored digest (idempotent bytes)", async () => {
  const samples = JSON.parse(await readFile(samplePath, "utf8")) as { tables: Record<string, any[]> };
  for (const row of samples.tables.node_revisions) {
    const content = obj(Object.fromEntries(ENVELOPE_KEYS.map((k) => [k, row[k]])) as Record<string, JcsValue>);
    expect(revisionOp(content).content_digest).toBe(row.content_digest);
  }
});

test("fixture timestamp adapter reads RAW microseconds and REJECTS sub-millisecond storage instead of rounding, including far dates", async () => {
  const root = await mkdtemp(join(tmpdir(), "arra-ts-boundary-"));
  try {
    // Python persists exact-ms, +1us, year-9999+1us and null into a real timestamp[us] column.
    const script = `
import lancedb, pyarrow as pa, sys
db = lancedb.connect(sys.argv[1])
schema = pa.schema([pa.field("id", pa.string(), nullable=False), pa.field("t", pa.timestamp("us"), nullable=True)])
vals = [1758166782000000, 1758166782000001, 253402300799999001, None]
db.create_table("ts", schema=schema).add(pa.table({"id": pa.array(["ms", "plus1us", "far", "null"]), "t": pa.array(vals, type=pa.timestamp("us"))}, schema=schema))
`;
    const r = spawnSync(python, ["-c", script, root], { encoding: "utf8", timeout: 60_000, env: { ...process.env, PYTHONPATH: source } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const db = await connect(root);
    try {
      const t = await db.openTable("ts");
      const arrow = await t.toArrow();
      const rows = await t.query().toArray();
      const col = arrow.getChild("t");
      const idx = (id: string) => rows.findIndex((x: any) => x.id === id);

      // The lossy accessor, measured: sub-ms becomes a fraction, far-date sub-ms becomes an INTEGER.
      expect(rows[idx("plus1us")].t).toBe(1758166782000.001);
      expect(rows[idx("far")].t).toBe(253402300799999);
      expect(Number.isInteger(rows[idx("far")].t)).toBe(true); // why Number.isInteger cannot be the guard

      // Raw microseconds are exact.
      expect(rawTimestampMicros(col, idx("ms"))).toBe(1758166782000000n);
      expect(rawTimestampMicros(col, idx("plus1us"))).toBe(1758166782000001n);
      expect(rawTimestampMicros(col, idx("far"))).toBe(253402300799999001n);
      expect(rawTimestampMicros(col, idx("null"))).toBeNull();

      // The adapter: accept exact, reject both sub-ms cases with the same code, pass null through.
      expect(timestampTextFromRaw(rawTimestampMicros(col, idx("ms")), "/t")).toBe("2025-09-18T03:39:42.000Z");
      expectError(() => timestampTextFromRaw(rawTimestampMicros(col, idx("plus1us")), "/t"), "out_of_range", "/t");
      expectError(() => timestampTextFromRaw(rawTimestampMicros(col, idx("far")), "/t"), "out_of_range", "/t");
      expect(timestampTextFromRaw(rawTimestampMicros(col, idx("null")), "/t")).toBeNull();
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
