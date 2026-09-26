import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { connect } from "@lancedb/lancedb";
// `apache-arrow` is @lancedb/lancedb's declared PEER dependency (">=15.0.0
// <=18.1.0") and lancedb re-exports it, so this adds no new dependency. The
// enum is imported rather than hardcoded precisely because that range spans
// several Arrow versions whose type ids must not be assumed.
import { Type } from "apache-arrow";
import { createHash } from "node:crypto";
import { formatInt64, formatTimestamp, validateId } from "../src/contracts/v1";
import { testTimeout } from "./helpers/timing.testTimeout";

// The literal expected target, written out here rather than derived, so a
// rename on the Python side shows up as a failure on the TypeScript side.
const TARGET_19 = [
  "workspaces", "peers", "sessions", "session_peers", "messages",
  "session_links",
  "nodes", "node_revisions", "node_revision_terms", "revision_links", "supersede_log",
  "vocabularies", "terms",
  "traces", "trace_hits",
  "search_chunks_v1",
  "mcp_calls", "connections", "read_cursors",
] as const;

const ACTIVE_15 = [
  "workspaces", "peers", "sessions", "session_peers", "messages",
  "memories", "vocabularies", "terms", "memory_terms", "supersede_log",
  "traces", "trace_hits", "mcp_calls", "connections", "read_cursors",
] as const;

const goldenPath = fileURLToPath(new URL("../../migrate-py/tests/fixtures/target-v1/golden-schema.json", import.meta.url));
const samplePath = fileURLToPath(new URL("../../migrate-py/tests/fixtures/target-v1/sample-rows.json", import.meta.url));
const scriptPath = fileURLToPath(new URL("../../migrate-py/tests/export_target_schema_fixture.py", import.meta.url));
const pythonPath = process.env.ARRA_CONTRACT_PYTHON ?? fileURLToPath(new URL("../../migrate-py/.venv/bin/python", import.meta.url));
const sourcePath = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));

type Triple = [string, string, boolean];
type Golden = { registry_version: string; status: string; provenance: string; tables: Record<string, Triple[]> };

/**
 * Render one Arrow JS type into the SAME closed vocabulary `target_v1.schema`
 * uses in Python. Independent implementation on purpose: two renderers that
 * agree are evidence, one renderer compared with itself is not.
 *
 * Unknown types THROW. They must never collapse into a neighbouring name --
 * an earlier draft of the Python side rendered Utf8 and LargeUtf8 identically
 * and therefore accepted a 32-bit/64-bit offset change as a match.
 *
 * Every case is keyed off the INSTALLED `Type` enum, never a literal id. An
 * earlier draft of this file hardcoded 21 for LargeList; apache-arrow 18.1.0
 * has no such member, so that branch was unreachable fiction. There is
 * deliberately no LargeList case now: Arrow JS cannot decode that type at all
 * and throws while reading the schema, upstream of this function -- measured,
 * and asserted below.
 */
function describeType(type: any): string {
  switch (type.typeId) {
    case Type.Bool: return "bool";
    case Type.Int: return `${type.isSigned ? "" : "u"}int${type.bitWidth}`;
    case Type.Float: {
      // float16 is deliberately NOT rendered. Python's describe_type has no
      // float16 branch either -- it falls through to `unsupported<halffloat>`,
      // a sentinel outside the closed vocabulary. Returning "float16" here
      // would be the one input where the two describers disagree without
      // either erroring, so this side throws instead of inventing a token the
      // Python vocabulary does not contain.
      const precision: Record<number, string> = { 1: "float32", 2: "float64" };
      const rendered = precision[type.precision as number];
      if (!rendered) throw new Error(`unsupported float precision ${type.precision} (float16 is outside the shared vocabulary)`);
      return rendered;
    }
    case Type.Utf8: return "utf8";
    case Type.LargeUtf8: return "large_utf8";     // 64-bit offsets, NOT utf8
    case Type.Timestamp: {
      const unit = ["s", "ms", "us", "ns"][type.unit];
      if (!unit) throw new Error(`unsupported timestamp unit ${type.unit}`);
      return type.timezone == null ? `timestamp[${unit}]` : `timestamp[${unit},${type.timezone}]`;
    }
    case Type.List: return `list<${child(type)}>`;
    case Type.FixedSizeList: return `fixed_size_list<${child(type)}>[${type.listSize}]`;
    default: throw new Error(`unsupported Arrow type id ${type.typeId} (${type.toString()})`);
  }
}

function child(type: any): string {
  const field = type.children?.[0];
  if (!field) throw new Error(`nested type ${type.toString()} has no child field`);
  return `${describeType(field.type)}${field.nullable ? "?" : ""}`;
}

function describeSchema(schema: any): Triple[] {
  return schema.fields.map((f: any) => [f.name, describeType(f.type), Boolean(f.nullable)] as Triple);
}

test("the installed Arrow JS SDK is the source of every type id this file uses", () => {
  // Pin the facts the descriptor relies on, read from the INSTALLED package.
  // If a future Arrow within lancedb's peer range renumbers or adds a member,
  // this fails loudly instead of the descriptor silently mis-rendering.
  const members = Type as unknown as Record<string, unknown>;
  expect(members.Utf8).toBe(5);
  expect(members.LargeUtf8).toBe(20);
  expect(members.LargeBinary).toBe(19);
  expect(members.List).toBe(12);
  expect(members.FixedSizeList).toBe(16);
  expect(members.Timestamp).toBe(10);
  expect(members.Int).toBe(2);
  expect(members.Float).toBe(3);
  expect(members.Bool).toBe(6);
  // apache-arrow 18.1.0 has NO LargeList member. The descriptor therefore has
  // no LargeList branch; see the read-side assertion in the fixture test for
  // what actually happens to such a column.
  expect("LargeList" in members).toBe(false);
  expect(Object.values(members)).not.toContain(21);
});

test("the TS descriptor renders the same vocabulary as Python, from real SDK types", () => {
  // Real type instances from the SDK, not hand-built shapes.
  const utf8 = new (require("apache-arrow").Utf8)();
  const largeUtf8 = new (require("apache-arrow").LargeUtf8)();
  expect(describeType(utf8)).toBe("utf8");
  expect(describeType(largeUtf8)).toBe("large_utf8");
  expect(describeType(utf8)).not.toBe(describeType(largeUtf8));

  const arrow = require("apache-arrow");
  const field = (name: string, type: any, nullable: boolean) => new arrow.Field(name, type, nullable);
  expect(describeType(new arrow.List(field("item", utf8, true)))).toBe("list<utf8?>");
  expect(describeType(new arrow.List(field("item", utf8, false)))).toBe("list<utf8>");
  expect(describeType(new arrow.FixedSizeList(384, field("item", new arrow.Float32(), true)))).toBe("fixed_size_list<float32?>[384]");
  expect(describeType(new arrow.Timestamp(arrow.TimeUnit.MICROSECOND))).toBe("timestamp[us]");
  expect(describeType(new arrow.Timestamp(arrow.TimeUnit.MICROSECOND, "UTC"))).toBe("timestamp[us,UTC]");
  expect(describeType(new arrow.Timestamp(arrow.TimeUnit.MILLISECOND))).toBe("timestamp[ms]");
  expect(describeType(new arrow.Int64())).toBe("int64");
  expect(describeType(new arrow.Int32())).toBe("int32");
  expect(describeType(new arrow.Float64())).toBe("float64");
  // Both describers refuse float16 rather than disagreeing about it.
  expect(() => describeType(new arrow.Float16())).toThrow(/float16 is outside the shared vocabulary/);
  expect(describeType(new arrow.Bool())).toBe("bool");
  // An unhandled real type is an error, never a nearest match.
  expect(() => describeType(new arrow.Struct([]))).toThrow(/unsupported Arrow type id/);
});

test("the checked-in golden is exactly the 19 target tables, in order", async () => {
  const golden = JSON.parse(await readFile(goldenPath, "utf8")) as Golden;
  expect(golden.registry_version).toBe("arra-v4-target/1");
  expect(golden.status).toBe("proposed-not-active");
  expect(Object.keys(golden.tables)).toEqual([...TARGET_19]);
  expect(new Set(TARGET_19).size).toBe(19);
  // 15 - 2 + 6 = 19, asserted as sets rather than as a count.
  const active = new Set<string>(ACTIVE_15);
  const replaced = ["memories", "memory_terms"];
  const added = ["session_links", "nodes", "node_revisions", "node_revision_terms", "revision_links", "search_chunks_v1"];
  expect((TARGET_19 as readonly string[]).filter((t) => !active.has(t))).toEqual(added);
  expect(replaced.filter((t) => (TARGET_19 as readonly string[]).includes(t))).toEqual([]);
  expect(active.size - replaced.length + added.length).toBe(19);
  // PINNED BY DIGEST. The previous toContain-per-disclaimer form was
  // append-blind: an audit appended "service invariants are now ALSO proven
  // and #23 is ACCEPTED" with every disclaimer left intact and all tests
  // stayed green. Same constant as PROVENANCE_DIGEST on the Python side, so
  // the two suites cannot drift apart on what they approved.
  expect(createHash("sha256").update(golden.provenance, "utf8").digest("hex"))
    .toBe("3cf03a3cbc99bc35984f20dd35f41b84ff9916d8ba0a130baddc75bdfb42351c");
  // Kept as readable documentation of what the digest protects.
  expect(golden.provenance).toContain("PHYSICAL FIELD / SCHEMA review is APPROVED");
  expect(golden.provenance).toContain("NOT approval of canonicalization");
  expect(golden.provenance).toContain("NOT of any service");
  expect(golden.provenance).toContain("NOT of runtime activation");
  expect(golden.provenance).toContain("NOT acceptance of issue #23");
  // No golden entry may carry Python's `unsupported<...>` sentinel: that token
  // means describe_type fell through, and the TS side would throw on the same
  // column, so the two sides could never have agreed on it.
  const allTypes = Object.values(golden.tables).flat().map((f) => f[1]);
  expect(allTypes.filter((t) => t.includes("unsupported<"))).toEqual([]);
});

test("Bun reads the persisted Arrow schema of all 19 Python-created tables", async () => {
  const golden = JSON.parse(await readFile(goldenPath, "utf8")) as Golden;
  const samples = JSON.parse(await readFile(samplePath, "utf8")) as { tables: Record<string, any[]> };
  const root = await mkdtemp(join(tmpdir(), "arra-target-schema-"));
  try {
    const result = spawnSync(pythonPath, [scriptPath, root], {
      encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONPATH: sourcePath },
    });
    if (result.error) throw new Error(`Python fixture unavailable: ${result.error.message}. Install migrate-py dependencies or set ARRA_CONTRACT_PYTHON.`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.registry_version).toBe("arra-v4-target/1");
    expect(proof.tables).toEqual([...TARGET_19]);
    expect(proof.golden_matches_persisted).toBe(true);

    const db = await connect(join(root, "target-v1-lancedb"));
    try {
      expect((await db.tableNames()).slice().sort()).toEqual([...TARGET_19].sort());
      for (const name of TARGET_19) {
        const table = await db.openTable(name);
        // Read the schema Bun sees on disk and compare it to the STATIC
        // golden -- not to anything this test just derived from that schema.
        expect([name, describeSchema(await table.schema())]).toEqual([name, golden.tables[name]]);
        expect(await table.countRows()).toBe(samples.tables[name].length);
      }

      // Gate D: the values, read through Arrow JS.
      const messages = await (await db.openTable("messages")).query().toArray();
      const big = messages.find((r: any) => r.public_id === samples.tables.messages[0].public_id)!;
      const small = messages.find((r: any) => r.public_id === samples.tables.messages[1].public_id)!;
      // Int64 arrives as bigint and survives beyond Number.MAX_SAFE_INTEGER.
      expect(typeof big.id).toBe("bigint");
      expect(formatInt64(big.id)).toBe("9223372036854775807");
      expect(formatInt64(small.id)).toBe("-9223372036854775808");
      expect(big.id > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(validateId(big.public_id)).toBe(samples.tables.messages[0].public_id);
      expect(big.content).toBe(samples.tables.messages[0].content);
      expect(big.content).toContain("ความทรงจำ");
      expect(big.workspace_name).toBe("บัญชี-primary");
      // Timestamps: same instant Python wrote, rendered back through the codec.
      expect(formatTimestamp(new Date(big.created_at))).toBe(samples.tables.messages[0].created_at);
      expect(formatTimestamp(new Date(big.ingested_at))).toBe(samples.tables.messages[0].ingested_at);
      expect(big.created_at).not.toBe(big.ingested_at);
      expect(small.source_created_at).toBeNull();
      expect(small.source_namespace).toBeNull();
      expect(formatTimestamp(new Date(small.read_at))).toBe("9999-12-31T23:59:59.999Z");

      const chunks = await (await db.openTable("search_chunks_v1")).query().toArray();
      const empty = chunks.find((r: any) => r.id === samples.tables.search_chunks_v1[0].id)!;
      const filled = chunks.find((r: any) => r.id === samples.tables.search_chunks_v1[1].id)!;
      expect(empty.embedding).toBeNull();
      expect(Array.from(empty.term_ids)).toEqual([]);           // empty list, not null
      expect(empty.status).toBe("pending");
      expect(filled.embedding).not.toBeNull();
      expect(Array.from(filled.embedding as Float32Array)).toEqual(samples.tables.search_chunks_v1[1].embedding);
      expect((filled.embedding as Float32Array).length).toBe(384);
      expect(Array.from(filled.term_ids)).toEqual(samples.tables.search_chunks_v1[1].term_ids);
      expect(filled.text).toBe("ภาษาไทย 🌱 body");

      const revisions = await (await db.openTable("node_revisions")).query().toArray();
      const firstRevision = revisions.find((r: any) => r.id === samples.tables.node_revisions[0].id)!;
      expect(firstRevision.term_snapshot_json).toBe("[]");
      expect(firstRevision.link_snapshot_json).toBe("[]");
      expect(JSON.parse(firstRevision.term_snapshot_json)).toEqual([]);   // shape only; not canonical bytes
      // Two physical rows share ordinal 1. No publication state is asserted
      // for either, and no uniqueness is claimed -- #26 owns both.
      expect(revisions.map((r: any) => Number(r.revision_no))).toEqual([1, 1]);

      // Legacy epoch-millisecond columns stay Int64 and are not reinterpreted.
      const traces = await (await db.openTable("traces")).query().toArray();
      expect(typeof traces[0].created_at).toBe("bigint");
      expect(formatInt64(traces[0].updated_at)).toBe("9007199254740993");  // > 2^53, exact only as bigint
      expect(traces[0].session_to_ts).toBeNull();
    } finally {
      db.close();
    }

    // Offset-width drift, end to end, against tables LanceDB really persisted.
    expect(proof.drift_probe).toEqual({
      large_utf8_probe: "large_string",
      large_list_probe: "large_list<item: string>",
    });
    const probeDb = await connect(join(root, "drift-probe-lancedb"));
    try {
      // large_string persists and Arrow JS decodes it -- and it is NOT utf8,
      // so comparing it against a utf8 golden entry is reported as drift.
      const largeUtf8Table = await probeDb.openTable("large_utf8_probe");
      const described = describeSchema(await largeUtf8Table.schema());
      expect(described).toEqual([["v", "large_utf8", false]]);
      expect(described).not.toEqual([["v", "utf8", false]]);

      // large_list persists too, but Arrow JS 18.1.0 cannot decode it: the
      // failure happens inside schema(), upstream of describeType. That is why
      // the descriptor has no LargeList branch to test. Measured, not assumed.
      const largeListTable = await probeDb.openTable("large_list_probe");
      await expect(largeListTable.schema()).rejects.toThrow(/Unrecognized type: "LargeList"/);
    } finally {
      probeDb.close();
    }

    // The exporter refuses to reuse a root, even on an identical retry.
    const retry = spawnSync(pythonPath, [scriptPath, root], {
      encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONPATH: sourcePath },
    });
    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain("FileExistsError");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, testTimeout(180_000));
