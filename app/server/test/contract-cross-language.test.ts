import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { connect } from "@lancedb/lancedb";
import { canonicalMessage, messageDigest, formatInt64, validateId } from "../src/contracts/v1";
import { testTimeout } from "./helpers/timing.testTimeout";

test("TS consumes the same proposed target-19 manifest without activating it", async () => {
  const path = fileURLToPath(new URL("../../migrate-py/contracts/target-19-manifest.json", import.meta.url));
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    status: string; target_count: number; current_registry_tables: string[]; target_tables: string[]; deferred: string[];
  };
  const current = ["workspaces", "peers", "sessions", "session_peers", "messages", "memories", "vocabularies", "terms", "memory_terms", "supersede_log", "traces", "trace_hits", "mcp_calls", "connections", "read_cursors"];
  const target = ["workspaces", "peers", "sessions", "session_peers", "messages", "session_links", "nodes", "node_revisions", "node_revision_terms", "revision_links", "supersede_log", "vocabularies", "terms", "traces", "trace_hits", "search_chunks_v1", "mcp_calls", "connections", "read_cursors"];
  expect(manifest.status).toBe("proposed-not-active");
  expect(manifest.target_count).toBe(19);
  expect(manifest.current_registry_tables).toEqual(current);
  expect(manifest.target_tables).toEqual(target);
  expect(new Set(target).size).toBe(19);
  expect(target.filter((table) => !current.includes(table))).toEqual(["session_links", "nodes", "node_revisions", "node_revision_terms", "revision_links", "search_chunks_v1"]);
  expect(manifest.deferred.length).toBeGreaterThan(0);
});

test("Python declares Arrow types and bytes; Bun reads the same scratch Lance rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "arra-codec-contract-"));
  const python = process.env.ARRA_CONTRACT_PYTHON ?? fileURLToPath(new URL("../../migrate-py/.venv/bin/python", import.meta.url));
  const script = fileURLToPath(new URL("../../migrate-py/tests/export_contract_fixture.py", import.meta.url));
  const source = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));
  const payload = {
    source_namespace: "relic://claude/session/transcript",
    source_message_id: "275",
    peer_name: "nat",
    role: "user",
    content: 'ความทรงจำ 🌱\n"quote"\\slash\t\u0000\u2028e\u0301',
    source_created_at: "2026-09-18T03:39:42.120Z",
    in_reply_to: null,
  };
  try {
    const result = spawnSync(python, [script, root], {
      input: JSON.stringify(payload), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PYTHONPATH: source },
    });
    if (result.error) throw new Error(`Python contract fixture unavailable: ${result.error.message}. Install existing migrate-py dependencies or set ARRA_CONTRACT_PYTHON.`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.canonical_hex).toBe(Buffer.from(canonicalMessage(payload)).toString("hex"));
    expect(proof.digest).toBe(messageDigest(payload));
    expect(proof.rows).toBe(2);
    const db = await connect(join(root, "codec-lancedb"));
    try {
      const table = await db.openTable("codec_fixture");
      const schema = await table.schema();
      expect(schema.fields.map((f) => [f.name, f.type.toString(), f.nullable])).toEqual([
        ["id", "Utf8", false], ["seq", "Int64", false],
        ["created_at", "Timestamp<MICROSECOND>", false],
        ["source_created_at", "Timestamp<MICROSECOND>", true],
        ["canonical_json", "Utf8", false], ["digest", "Utf8", false],
        ["embedding", "FixedSizeList[384]<Float32>", true],
      ]);
      const rows = await table.query().toArray();
      expect(rows).toHaveLength(2);
      const row = rows.find((r) => r.id === "Abcdefghijklmnopq_012")!;
      const sourced = rows.find((r) => r.id === "Abcdefghijklmnopq_013")!;
      expect(validateId(row.id)).toBe("Abcdefghijklmnopq_012");
      expect(validateId(sourced.id)).toBe("Abcdefghijklmnopq_013");
      expect(sourced.source_created_at).toBe(Date.parse(payload.source_created_at));
      expect(formatInt64(row.seq)).toBe("9223372036854775807");
      expect(row.created_at).toBe(Date.parse(payload.source_created_at));
      expect(row.source_created_at).toBeNull();
      expect(row.embedding).toBeNull();
      expect(row.canonical_json).toBe(new TextDecoder().decode(canonicalMessage(payload)));
      expect(row.digest).toBe(messageDigest(payload));
    } finally {
      db.close();
    }
    // The exporter refuses an existing target, even on an otherwise identical retry.
    const retry = spawnSync(python, [script, root], {
      input: JSON.stringify(payload), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PYTHONPATH: source },
    });
    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain("FileExistsError");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, testTimeout(60_000));

test("Python and TS accept/reject the same message corpus with identical bytes", () => {
  const base = { source_namespace: "relic://bank/provider/session/transcript", source_message_id: "1", peer_name: "neo", role: null, content: "ภาษาไทย 🌱", source_created_at: null, in_reply_to: null };
  const corpus: unknown[] = [base, null, [], {}, { ...base, extra: "ignored?" }];
  for (const key of Object.keys(base)) {
    corpus.push(Object.fromEntries(Object.entries(base).filter(([k]) => k !== key)));
    for (const value of [null, "", false, 0, "\ud800", "\udfff", "\n\t\b\f\r\u0000\u2028\u2029", "é", "e\u0301", "0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "2026-02-29T00:00:00.000Z"]) {
      corpus.push({ ...base, [key]: value });
    }
  }
  const python = process.env.ARRA_CONTRACT_PYTHON ?? fileURLToPath(new URL("../../migrate-py/.venv/bin/python", import.meta.url));
  const source = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));
  const result = spawnSync(python, ["-c", `
import json, sys
from arra_migrate.contract_v1 import canonical_message, message_digest
results = []
for item in json.load(sys.stdin):
    try:
        results.append({"hex": canonical_message(item).hex(), "digest": message_digest(item)})
    except (ValueError, TypeError):
        results.append({"rejected": True})
print(json.dumps(results))
`], { input: JSON.stringify(corpus), encoding: "utf8", timeout: 30_000, env: { ...process.env, PYTHONPATH: source } });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const expected = JSON.parse(result.stdout);
  expect(expected).toHaveLength(corpus.length);
  corpus.forEach((payload, i) => {
    let actual;
    try {
      actual = { hex: Buffer.from(canonicalMessage(payload)).toString("hex"), digest: messageDigest(payload) };
    } catch {
      actual = { rejected: true };
    }
    expect(actual).toEqual(expected[i]);
  });
});
