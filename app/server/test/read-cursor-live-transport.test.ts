// #75 re-certification over the LIVE transports (acceptance-criteria slice,
// 2026-09-26): a representative replay of the frozen read-cursor-v1.md
// ownership, precision and recovery checks, on a REAL listening server over a
// fresh writer-gated dataset (`fixtures/transport-v1/live-server/child.ts`),
// over HTTP AND MCP. The exhaustive kernel proofs stay in
// read-cursor-{service,ownership,precision,recovery}.test.ts; this file
// proves the same rules survive admission and both wires.
//
//   ownership  owner advances and reads; a peer-bound credential naming
//              another peer (R3), a credential of another workspace and a
//              content:read-only credential are refused with the contract's
//              codes, and none of them changes the row.
//   precision  §2: `last_read_at` is exact UTC-millisecond text; a replay
//              keeps the first timestamp; the next advance is not earlier.
//   decisions  §4: already_satisfied, conflict/backward, conflict/expected;
//              §3: a wrong-session message is invalid_reference, a legacy
//              numeric id fails the nanoid grammar.
//   recovery   §5: a FRESH owner (a second server process on the same dataset)
//              retrying a landed write gets already_satisfied with the
//              retained row, and reads the same row.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, runGated } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = join(import.meta.dir, "fixtures", "transport-v1", "live-server", "child.ts");
const TEST_TIMEOUT_MS = testTimeout(240_000);
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/transport-v1/live-server/child.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const M = [1, 2, 3, 4].map((i) => pad(`rcmsg${i}x`));
const OTHER_MSG = pad("rcother1x");
const MS_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const key = (peer: string) => ({ workspace_name: ALPHA, peer_name: peer, session_name: "rc-main" });
const advance = (peer: string, id: string, expected: null | { last_read_message_id: string | null }) => ({
  ...key(peer),
  last_read_message_id: id,
  expected,
});

type Step = Record<string, unknown>;
const http = (label: string, token: string, method: string, body: unknown, bank = "alpha"): Step => ({
  label, transport: "http", token, bank, method, body,
});
const mcp = (label: string, token: string, method: string, body: unknown, bank = "alpha"): Step => ({
  label, transport: "mcp", token, bank, method: `kb_${method}`, body: { payload: body },
});
const both = (label: string, token: string, method: string, body: unknown, bank = "alpha"): Step[] => [
  http(`${label}_http`, token, method, body, bank),
  mcp(`${label}_mcp`, token, method, body, bank),
];

const append = (session: string, ids: string[]) => ({
  workspace_name: ALPHA,
  session_name: session,
  items: ids.map((public_id) => ({
    public_id,
    message: { peer_name: "peer-a", role: null, content: `message ${public_id}`, in_reply_to: null },
    source: null,
  })),
});

async function runChild(root: string, steps: Step[]): Promise<Record<string, any>> {
  const workDir = await mkdtemp(join(tmpdir(), "arra-v4-read-cursor-live-"));
  cleanups.push(() => rm(workDir, { recursive: true, force: true }));
  const result = await runGated(root, CHILD, [root, workDir, JSON.stringify({ banks: { alpha: ALPHA, beta: BETA }, steps })]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(-2000)}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

/** The value a step returned on success, whichever transport carried it. */
const valueOf = (outcome: any) => {
  if (outcome?.body !== undefined) {
    expect(outcome.status, JSON.stringify(outcome)).toBe(200);
    return outcome.body;
  }
  expect(outcome?.isError, JSON.stringify(outcome)).toBe(false);
  return outcome.value;
};
/** A refusal's governed code, whichever transport carried it. */
const refusal = (outcome: any): { status: number; code: string | null; path: string | null } => {
  if (outcome?.body !== undefined) {
    return { status: outcome.status, code: outcome.body?.code ?? outcome.body?.error ?? null, path: outcome.body?.path ?? null };
  }
  if (outcome?.denied !== undefined) {
    let code: string | null = null;
    try {
      code = JSON.parse(outcome.denied).error ?? null;
    } catch {}
    return { status: outcome.status, code, path: null };
  }
  expect(outcome?.isError, JSON.stringify(outcome)).toBe(true);
  return { status: 200, code: outcome.value?.code ?? null, path: outcome.value?.path ?? null };
};

runIt(
  "read-cursor ownership, precision and recovery hold over live HTTP and MCP",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const root = fixture.datasetRoot;

    const first = await runChild(root, [
      // ── seed, over HTTP with the unbound writer ────────────────────────
      http("peer_a", "write", "registerPeer", { workspace_name: ALPHA, peer_id: pad("rcpeera"), name: "peer-a" }),
      http("peer_b", "write", "registerPeer", { workspace_name: ALPHA, peer_id: pad("rcpeerb"), name: "peer-b" }),
      http("sess_main", "write", "registerSession", { workspace_name: ALPHA, session_id: pad("rcsess1"), name: "rc-main" }),
      http("sess_other", "write", "registerSession", { workspace_name: ALPHA, session_id: pad("rcsess2"), name: "rc-other" }),
      http("join_main", "write", "joinSession", { workspace_name: ALPHA, session_name: "rc-main", peer_name: "peer-a" }),
      http("join_other", "write", "joinSession", { workspace_name: ALPHA, session_name: "rc-other", peer_name: "peer-a" }),
      http("append_main", "write", "appendMessages", append("rc-main", M)),
      http("append_other", "write", "appendMessages", append("rc-other", [OTHER_MSG])),

      // ── owner (peer-bound to peer-a) ───────────────────────────────────
      ...both("get_empty", "bound", "getReadCursor", key("peer-a")),
      http("create_http", "bound", "advanceReadCursor", advance("peer-a", M[1]!, null)),
      mcp("replay_mcp", "bound", "advanceReadCursor", advance("peer-a", M[1]!, null)),
      mcp("advance_mcp", "bound", "advanceReadCursor", advance("peer-a", M[2]!, { last_read_message_id: M[1]! })),
      ...both("get_owner", "bound", "getReadCursor", key("peer-a")),
      // §4 rule 2 and rule 3, on both wires.
      ...both("backward", "bound", "advanceReadCursor", advance("peer-a", M[0]!, { last_read_message_id: M[2]! })),
      ...both("stale", "bound", "advanceReadCursor", advance("peer-a", M[3]!, { last_read_message_id: M[1]! })),
      // §3: wrong-session desired message; legacy numeric id.
      ...both("wrong_session", "bound", "advanceReadCursor", advance("peer-a", OTHER_MSG, { last_read_message_id: M[2]! })),
      ...both("numeric_id", "bound", "advanceReadCursor", advance("peer-a", "42", { last_read_message_id: M[2]! })),

      // ── refusals ───────────────────────────────────────────────────────
      // Non-owner: the peer-a-bound credential naming peer-b (R3).
      ...both("nonowner_get", "bound", "getReadCursor", key("peer-b")),
      ...both("nonowner_adv", "bound", "advanceReadCursor", advance("peer-b", M[3]!, null)),
      // Cross-workspace: a beta-only credential on the alpha route, and on
      // its own route naming alpha in the body.
      ...both("cross_get", "other", "getReadCursor", key("peer-a")),
      ...both("cross_adv", "other", "advanceReadCursor", advance("peer-a", M[3]!, { last_read_message_id: M[2]! })),
      http("cross_body_http", "other", "advanceReadCursor", advance("peer-a", M[3]!, { last_read_message_id: M[2]! }), "beta"),
      // Readonly: content:read may read, never advance.
      ...both("readonly_get", "read", "getReadCursor", key("peer-a")),
      ...both("readonly_adv", "read", "advanceReadCursor", advance("peer-a", M[3]!, { last_read_message_id: M[2]! })),

      // Nothing refused above moved the row.
      ...both("get_final", "bound", "getReadCursor", key("peer-a")),
    ]);

    for (const label of ["peer_a", "peer_b", "sess_main", "sess_other", "join_main", "join_other", "append_main", "append_other"]) {
      expect(first[label].status, `${label}: ${JSON.stringify(first[label])}`).toBe(200);
    }

    // ── owner can advance and read ──────────────────────────────────────
    expect(valueOf(first.get_empty_http)).toBeNull();
    expect(valueOf(first.get_empty_mcp)).toBeNull();
    const created = valueOf(first.create_http);
    expect(created.outcome).toBe("created");
    expect(Object.keys(created.row)).toEqual([
      "workspace_name", "peer_name", "session_name", "last_read_message_id", "last_read_at",
    ]);
    expect(created.row).toMatchObject({ workspace_name: ALPHA, peer_name: "peer-a", session_name: "rc-main", last_read_message_id: M[1] });
    expect(created.row.last_read_at).toMatch(MS_TEXT);

    // precision: a replay keeps the FIRST timestamp, byte for byte.
    const replay = valueOf(first.replay_mcp);
    expect(replay).toEqual({ outcome: "already_satisfied", row: created.row });

    const advanced = valueOf(first.advance_mcp);
    expect(advanced.outcome).toBe("advanced");
    expect(advanced.row.last_read_message_id).toBe(M[2]);
    expect(advanced.row.last_read_at).toMatch(MS_TEXT);
    expect(Date.parse(advanced.row.last_read_at)).toBeGreaterThanOrEqual(Date.parse(created.row.last_read_at));
    expect(valueOf(first.get_owner_http)).toEqual(advanced.row);
    expect(valueOf(first.get_owner_mcp)).toEqual(advanced.row);

    // ── §4 decisions are results, not errors, on both wires ─────────────
    for (const via of ["http", "mcp"]) {
      expect(valueOf(first[`backward_${via}`])).toEqual({ outcome: "conflict", reason: "backward", row: advanced.row });
      expect(valueOf(first[`stale_${via}`])).toEqual({ outcome: "conflict", reason: "expected", row: advanced.row });
      const wrong = refusal(first[`wrong_session_${via}`]);
      expect(wrong.code, JSON.stringify(first[`wrong_session_${via}`])).toBe("invalid_reference");
      expect(wrong.path).toBe("/last_read_message_id");
      const numeric = refusal(first[`numeric_id_${via}`]);
      expect(numeric.code, JSON.stringify(first[`numeric_id_${via}`])).not.toBeNull();
      expect(JSON.stringify(first[`numeric_id_${via}`])).toContain("last_read_message_id");
    }
    expect(first.wrong_session_http.status).toBe(400);
    expect(first.numeric_id_http.status).toBe(400);

    // ── refusals, with the contract's codes ─────────────────────────────
    for (const via of ["http", "mcp"]) {
      for (const label of ["nonowner_get", "nonowner_adv"]) {
        const r = refusal(first[`${label}_${via}`]);
        expect(r.code, `${label}_${via}: ${JSON.stringify(first[`${label}_${via}`])}`).toBe("forbidden");
        expect(r.path).toBe("/peer_name");
      }
      for (const label of ["cross_get", "cross_adv", "readonly_adv"]) {
        const r = refusal(first[`${label}_${via}`]);
        expect(r.code, `${label}_${via}: ${JSON.stringify(first[`${label}_${via}`])}`).toBe("forbidden");
      }
      // The readonly credential can still read the owner's row.
      expect(valueOf(first[`readonly_get_${via}`])).toEqual(advanced.row);
    }
    for (const label of ["nonowner_get", "nonowner_adv", "cross_get", "cross_adv", "readonly_adv"]) {
      expect(first[`${label}_http`].status, label).toBe(403);
    }
    // Scope in the body must equal the route bank: refused before admission.
    expect(first.cross_body_http.status).toBe(400);
    // The row the owner left is the row that remains.
    expect(valueOf(first.get_final_http)).toEqual(advanced.row);
    expect(valueOf(first.get_final_mcp)).toEqual(advanced.row);

    // ── recovery: a FRESH owner process retries the landed write ────────
    const second = await runChild(root, [
      http("retry_http", "bound", "advanceReadCursor", advance("peer-a", M[2]!, { last_read_message_id: M[1]! })),
      mcp("retry_mcp", "bound", "advanceReadCursor", advance("peer-a", M[2]!, { last_read_message_id: M[1]! })),
      ...both("get_fresh", "bound", "getReadCursor", key("peer-a")),
    ]);
    expect(valueOf(second.retry_http)).toEqual({ outcome: "already_satisfied", row: advanced.row });
    expect(valueOf(second.retry_mcp)).toEqual({ outcome: "already_satisfied", row: advanced.row });
    expect(valueOf(second.get_fresh_http)).toEqual(advanced.row);
    expect(valueOf(second.get_fresh_mcp)).toEqual(advanced.row);
  },
  TEST_TIMEOUT_MS,
);
