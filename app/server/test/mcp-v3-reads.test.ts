// Slice V2 -- the v3 knowledge reads: oracle_read, oracle_supersede,
// oracle_verify (docs/overnight/V3-PARITY.md §3 A3/A6, §4.2/§4.3, §7 "V2";
// DECISIONS.md R18 D1/D3). Written BEFORE the three tools existed.
//
// Real gate, real dataset, real wire: reuses `fixtures/v3-compat-v1/core/
// writes-child.ts` (V1's gated child, generic over any tool name) to boot the
// production app inside `exec_with_gate` and replay MCP calls. What is
// asserted is what a real client reading over the wire would see.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, runGated, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";
import { scaledMs } from "./helpers/timing.scaledMs";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const A = "ws-a";
const B = "ws-b";
const NOT_A_NANOID = "3264052e-e8d4-4a64-a255-8e72b0e0979b"; // a v3-style UUID trace id (D9)
const MISSING_NANOID = "a".repeat(21); // well-formed nanoid21, no such node (D1 "ordinary not found")

let fixture: Fixture;
let work: string;
let out: Record<string, any> = {};
/** A learn step's own outcome carries the node id at `.value.id`; the
 *  child's internal `$ref` capture map is never returned to the parent. */
const id = (label: string) => out[label].value.id as string;

async function runChild(banks: string[], steps: unknown[]) {
  const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, work, JSON.stringify({ banks, operator: [], steps })], {
    deadlineMs: scaledMs(180_000),
    env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot },
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (result.code !== 0 || line === undefined) throw new Error(`writes-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  return JSON.parse(line);
}

const learn = (label: string, bank: string, pattern: string, captureAs?: string) => ({
  label, bank, tool: "oracle_learn", args: { pattern }, capture: { name: captureAs ?? label, path: ["id"] },
});
const read = (label: string, bank: string, id: unknown, as: "rw" | "free" | "ro" = "rw") => ({ label, bank, as, tool: "oracle_read", args: { id } });
const supersede = (label: string, bank: string, oldId: unknown, newId: unknown, extra: Record<string, unknown> = {}) => ({
  label, bank, tool: "oracle_supersede", args: { oldId, newId, ...extra },
});
const history = (label: string, bank: string, nodeId: unknown) => ({
  label, bank, tool: "kb_listLifecycleHistory", args: { payload: { workspace_name: bank, node_id: nodeId, after_event_id: null, limit: 1 } },
});

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-reads-"));
  await mkdir(join(work, "legacy"));
  fixture = await createFixture([A, B]);

  out = await runChild([A, B], [
    learn("L1", A, "The rollback point is the last known-good snapshot."),
    learn("L1B", A, "The rollback point is the last known-good snapshot, with rationale."),
    learn("L1C", A, "A third, unrelated replacement candidate."),
    learn("L2", A, "A lonely node nobody supersedes."),
    learn("L3", A, "Superseded with no reason argument."),
    learn("L4", A, "The default-reason successor."),
    learn("L5", A, "Superseded by a bound speaker."),
    learn("L6", A, "The bound-speaker successor."),

    read("read_ok", A, { $ref: "L1" }),
    { label: "read_no_file_or_id", bank: A, tool: "oracle_read", args: {} },
    { label: "read_file_not_carried", bank: A, tool: "oracle_read", args: { file: "notes/x.md" } },
    read("read_legacy_id_unknown", A, NOT_A_NANOID),
    read("read_missing_nanoid", A, MISSING_NANOID),
    read("read_cross_bank", B, { $ref: "L1" }, "free"),

    supersede("supersede_self", A, { $ref: "L2" }, { $ref: "L2" }),
    supersede("supersede_ok", A, { $ref: "L1" }, { $ref: "L1B" }, { reason: "more comprehensive" }),
    history("history_after_ok", A, { $ref: "L1" }),
    read("read_after_supersede", A, { $ref: "L1" }),
    supersede("supersede_repeat", A, { $ref: "L1" }, { $ref: "L1B" }, { reason: "more comprehensive" }),
    history("history_after_repeat", A, { $ref: "L1" }),
    supersede("supersede_different_successor", A, { $ref: "L1" }, { $ref: "L1C" }),
    supersede("supersede_into_terminal", A, { $ref: "L2" }, { $ref: "L1" }),
    supersede("supersede_default_reason", A, { $ref: "L3" }, { $ref: "L4" }),
    { label: "supersede_bound_peer", bank: A, tool: "oracle_supersede", peer: "neo", args: { oldId: { $ref: "L5" }, newId: { $ref: "L6" } } },
    history("history_bound_peer", A, { $ref: "L5" }),

    { label: "verify_ok", bank: A, tool: "oracle_verify", args: {} },
    { label: "verify_check_false", bank: A, tool: "oracle_verify", args: { check: false } },
    { label: "verify_type_ignored", bank: A, tool: "oracle_verify", args: { type: "learning" } },
  ]);
}, testTimeout(300_000));

afterAll(async () => {
  await fixture?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("oracle_read (V2)", () => {
  test("round-trips the body and marks the v4-native source, with no server file", () => {
    const res = out.read_ok;
    expect(res.isError).toBe(false);
    expect(res.value.content).toBe("The rollback point is the last known-good snapshot.");
    expect(res.value.source).toBe("node");
    expect(res.value.source_file).toBeNull();
    expect(res.value.resolved_path).toBeNull();
    expect(res.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "source_file" }));
    expect(res.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "resolved_path" }));
    expect(res.value.v4.node_id).toBe(id("L1"));
    expect(typeof res.value.v4.revision_id).toBe("string");
  });

  test("file is not carried; neither id nor file is unsupported_argument", () => {
    expect(out.read_file_not_carried.isError).toBe(true);
    expect(out.read_file_not_carried.value.compat.code).toBe("not_carried");
    expect(out.read_no_file_or_id.isError).toBe(true);
    expect(out.read_no_file_or_id.value.compat.code).toBe("unsupported_argument");
  });

  test("a v3-style id answers legacy_id_unknown (D9); a well-formed but absent nanoid21 answers no_results", () => {
    expect(out.read_legacy_id_unknown.isError).toBe(true);
    expect(out.read_legacy_id_unknown.value.compat.code).toBe("legacy_id_unknown");
    expect(out.read_missing_nanoid.isError).toBe(true);
    expect(out.read_missing_nanoid.value.compat.code).toBe("no_results");
  });

  test("a bank-a id is not found from bank-b (workspace isolation)", () => {
    expect(out.read_cross_bank.isError).toBe(true);
  });
});

describe("oracle_supersede (V2, D1/D3)", () => {
  test("refuses superseding a document with itself", () => {
    expect(out.supersede_self.isError).toBe(true);
    expect(out.supersede_self.value.compat.code).toBe("semantic_refusal");
  });

  test("supersedes with v3's success shape, type labels and a real ISO timestamp", () => {
    const res = out.supersede_ok;
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ success: true, old_id: id("L1"), old_type: "learning", new_id: id("L1B"), new_type: "learning", reason: "more comprehensive" });
    expect(typeof res.value.superseded_at).toBe("string");
    expect(Number.isNaN(Date.parse(res.value.superseded_at))).toBe(false);
    expect(typeof res.value.message).toBe("string");
  });

  test("read(old) is a browse path: still returns the body, flagged with superseded_by/_at/_reason", () => {
    const res = out.read_after_supersede;
    expect(res.isError).toBe(false);
    expect(res.value.superseded_by).toBe(id("L1B"));
    expect(res.value.superseded_reason).toBe("more comprehensive");
    expect(typeof res.value.superseded_at).toBe("string");
  });

  test("the same supersede again returns unchanged:true, never a second lifecycle event", () => {
    const res = out.supersede_repeat;
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ success: true, unchanged: true, old_id: id("L1"), new_id: id("L1B") });
    const rows = out.history_after_repeat.value.rows;
    expect(rows.length).toBe(1);
  });

  test("already superseded by a DIFFERENT successor is a semantic_refusal naming it", () => {
    const res = out.supersede_different_successor;
    expect(res.isError).toBe(true);
    expect(res.value.compat.code).toBe("semantic_refusal");
    expect(res.value.error).toContain(id("L1B"));
  });

  test("superseding INTO an already-terminal successor is refused (#29 successor_terminal)", () => {
    const res = out.supersede_into_terminal;
    expect(res.isError).toBe(true);
    expect(res.value.compat.code).toBe("semantic_refusal");
  });

  test("with no reason argument, the default reason is recorded", () => {
    const res = out.supersede_default_reason;
    expect(res.isError).toBe(false);
    expect(res.value.reason).toBe("v3 adapter: reason not recorded");
  });

  test("a bound speaker (X-Arra-Peer) is ensured via getPeer/registerPeer and lands as the lifecycle event's peer_name", () => {
    const res = out.supersede_bound_peer;
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ success: true, old_id: id("L5"), new_id: id("L6") });
    const row = out.history_bound_peer.value.rows[0];
    expect(row.peer_name).toBe("neo");
  });
});

describe("oracle_verify (V2, GAP: no getSearchFreshness on this base)", () => {
  test("reports index completeness from reconcileSearchChunks, with the closed-set warnings named", () => {
    const res = out.verify_ok;
    expect(res.isError).toBe(false);
    expect(typeof res.value.healthy).toBe("number");
    expect(typeof res.value.missing).toBe("number");
    expect(typeof res.value.drifted).toBe("number");
    expect(res.value.orphaned).toBeNull();
    expect(res.value.untracked).toBeNull();
    expect(Array.isArray(res.value.missing_documents)).toBe(true);
    expect(res.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "orphaned" }));
    expect(res.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "untracked" }));
  });

  test("check:false is not carried (v3 invented a successor id)", () => {
    expect(out.verify_check_false.isError).toBe(true);
    expect(out.verify_check_false.value.compat.code).toBe("not_carried");
  });

  test("a type filter is accepted and ignored, named in compat_warnings", () => {
    expect(out.verify_type_ignored.isError).toBe(false);
    expect(out.verify_type_ignored.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "argument_ignored", field: "type" }));
  });
});
