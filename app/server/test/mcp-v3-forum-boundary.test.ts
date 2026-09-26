// Fix round of slices V4 + K9-K11 (docs/overnight/V3-PARITY.md §4.3, §5;
// DECISIONS.md R3, R18 D7/D8): the independent verifier's findings, each
// pinned where it could recur. Seen red first beside the rest of
// `mcp-v3-forum.test.ts`, then moved here to keep both files under 500 lines.
//
//  - An idempotency_key is the SPEAKER's own. Another speaker's same key used
//    to answer `already_satisfied` on the first speaker's thread and join that
//    speaker and every `to` recipient into it before the post was refused --
//    a silent join, which under R3 is read access (§4.3).
//  - Nobody but the speaker joins before the post is stored; a keyed thread
//    that exists without the speaker is refused with no join at all.
//  - Continuing a closed thread (reopen) is a current member's act.
//  - `listSessionMembers` is behind the R3 boundary; a `closeSession` naming
//    no peer is the audit:read operator path.
//  - Every refusal a read can decide comes before any write.
//
// Real gate, real dataset, real wire (`fixtures/v3-compat-v1/core/forum-child.ts`).
// Principals: rw (bound to neo), free (no binding), ro, audit (read +
// audit:read), opw (write + audit:read).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivedId } from "../src/mcp/legacy-v3/ids.derivedId";
import { runGated } from "./helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "forum-child.ts");
const F = "ws-forum";
const ref = (name: string) => ({ $ref: name });
/** The session id nat's oracle_thread derives from idempotency_key "squat-key". */
const SQUAT = derivedId(F, "session", "oracle_thread", "nat", "squat-key");
const HTTP_REASON = 'done: ลืม "quoted" \\ ok';

const kb = (label: string, method: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ label, bank: F, tool: `kb_${method}`, args: { payload: { workspace_name: F, ...payload } }, ...extra });
/** The same payload over HTTP `/api/knowledge/<bank>/<method>` (the CLI's route too). */
const http = (label: string, method: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ label, bank: F, tool: `http:${method}`, args: { workspace_name: F, ...payload }, ...extra });
const session = (label: string, name: string) => kb(label, "getSession", { session_name: ref(name) });
/** Read back as the audit:read operator: the member list is behind R3. */
const membersAt = (label: string, name: unknown) =>
  kb(label, "listSessionMembers", { session_name: name, after_name: null, limit: 100 }, { as: "audit" });
const members = (label: string, name: string) => membersAt(label, ref(name));
const say = (label: string, peer: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ label, bank: F, peer, tool: "oracle_thread", args, ...extra });
const read = (label: string, peer: string | undefined, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ label, bank: F, ...(peer ? { peer } : {}), tool: "oracle_thread_read", args, ...extra });
const update = (label: string, peer: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ label, bank: F, peer, tool: "oracle_thread_update", args, ...extra });
const listed = (label: string, sessionName: unknown, extra: Record<string, unknown> = {}, as?: string) =>
  kb(label, "listSessionMembers", { session_name: sessionName, after_name: null, limit: 100, ...extra }, as === undefined ? {} : { as });

let fixture: TaxonomyFixture;
let work: string;
let out: Record<string, any> = {};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-forum-boundary-"));
  await mkdir(join(work, "legacy"));
  fixture = await createTaxonomyFixture([F]);
  const steps = [
    // Each oracle registers by speaking once.
    say("zoe_hello", "zoe", { message: "zoe registers by speaking" }, { as: "free" }),
    // 1. Two speakers, one idempotency_key.
    say("shared_neo", "neo", { message: "neo private body", idempotency_key: "shared" }, { capture: { name: "TS", path: ["thread_id"] } }),
    say("shared_nat", "nat", { message: "nat new thread", idempotency_key: "shared", to: ["zoe"] }, { as: "free", capture: { name: "TN", path: ["thread_id"] } }),
    say("shared_nat_retry", "nat", { message: "nat new thread", idempotency_key: "shared", to: ["zoe"] }, { as: "free" }),
    members("shared_ts_members", "TS"),
    members("shared_tn_members", "TN"),
    read("shared_nat_read", "nat", { threadId: ref("TS") }, { as: "free" }),
    read("shared_zoe_read", "zoe", { threadId: ref("TS") }, { as: "free" }),
    // 2. The name a key derives already exists WITHOUT the speaker.
    kb("squat_register", "registerSession", { session_id: SQUAT, name: `t-${SQUAT}` }),
    say("squat_post", "nat", { message: "into the squat", idempotency_key: "squat-key", to: ["zoe"] }, { as: "free" }),
    membersAt("squat_members", `t-${SQUAT}`),
    read("squat_audit_read", undefined, { threadId: `t-${SQUAT}` }, { as: "audit" }),
    // 3. Reopen: a stranger is refused and writes nothing; a member still may.
    say("tx", "nat", { message: "to be closed", to: ["zoe"] }, { as: "free", capture: { name: "TX", path: ["thread_id"] } }),
    update("tx_close", "nat", { threadId: ref("TX"), status: "closed" }, { as: "free" }),
    say("ghosty_reopen", "ghosty", { threadId: ref("TX"), message: "i was never here", reopen: true }, { as: "free" }),
    kb("ghosty_peer", "getPeer", { peer_name: "ghosty" }),
    kb("ghosty_threads", "listSessions", { after_name: null, limit: 100, include_total: false, member_peer_name: "ghosty" }, { as: "audit" }),
    say("tx_reopen", "nat", { threadId: ref("TX"), message: "continued", reopen: true }, { as: "free", capture: { name: "TY", path: ["thread_id"] } }),
    members("ty_members", "TY"),
    // 4. The member list over kb_*: rw is bound to neo and holds no audit:read.
    listed("mem_rw_no_requester", ref("TN")),
    listed("mem_rw_nonmember", ref("TN"), { requester_peer_name: "neo" }),
    listed("mem_rw_other", ref("TN"), { requester_peer_name: "nat" }),
    listed("mem_rw_member", ref("TS"), { requester_peer_name: "neo" }),
    // 5. Closing with no peer is the operator path.
    say("tc", "nat", { message: "to be closed by an operator" }, { as: "free", capture: { name: "TC", path: ["thread_id"] } }),
    kb("close_null_rw", "closeSession", { session_name: ref("TC"), reason: "gotcha", peer_name: null, operation_id: "null-1" }),
    kb("close_null_free", "closeSession", { session_name: ref("TC"), reason: "gotcha", peer_name: null, operation_id: "null-2" }, { as: "free" }),
    session("tc_open", "TC"),
    kb("close_null_opw", "closeSession", { session_name: ref("TC"), reason: "operator close", peer_name: null, operation_id: "null-3" }, { as: "opw" }),
    session("tc_closed", "TC"),
    // 6. A title over the kernel's 1024-byte cap (513 two-byte characters:
    // bytes are counted, not characters) is refused before any write.
    say("long_title", "tia", { message: "x", title: "é".repeat(513) }, { as: "free" }),
    kb("tia_peer", "getPeer", { peer_name: "tia" }),
    // 7. The two K9/K10 kernels over HTTP too (the live probe has no fixture for them).
    say("th_http", "nat", { message: "http close target" }, { as: "free", capture: { name: "TH_HTTP", path: ["thread_id"] } }),
    http("http_members_stranger", "listSessionMembers", { session_name: ref("TH_HTTP"), after_name: null, limit: 10, requester_peer_name: "neo" }),
    http("http_members_member", "listSessionMembers", { session_name: ref("TH_HTTP"), after_name: null, limit: 10, requester_peer_name: "nat" }, { as: "free" }),
    http("http_members_operator", "listSessionMembers", { session_name: ref("TH_HTTP"), after_name: null, limit: 10 }, { as: "audit" }),
    http("http_members_ro", "listSessionMembers", { session_name: ref("TH_HTTP"), after_name: null, limit: 10 }, { as: "ro" }),
    http("http_close_other", "closeSession", { session_name: ref("TH_HTTP"), reason: "x", peer_name: "nat", operation_id: "h-1" }),
    http("http_close_null", "closeSession", { session_name: ref("TH_HTTP"), reason: "x", peer_name: null, operation_id: "h-2" }),
    http("http_close_ro", "closeSession", { session_name: ref("TH_HTTP"), reason: "x", peer_name: "nat", operation_id: "h-0" }, { as: "ro" }),
    http("http_close_member", "closeSession", { session_name: ref("TH_HTTP"), reason: HTTP_REASON, peer_name: "nat", operation_id: "h-3" }, { as: "free" }),
    http("http_close_again", "closeSession", { session_name: ref("TH_HTTP"), reason: HTTP_REASON, peer_name: "nat", operation_id: "h-3" }, { as: "free" }),
  ];
  const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, work, JSON.stringify({ banks: [F], steps })], {
    deadlineMs: 240_000,
    env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot },
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (result.code !== 0 || line === undefined) throw new Error(`forum-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  out = JSON.parse(line);
}, 300_000);

afterAll(async () => {
  await fixture?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
});

const ok = (label: string) => {
  const res = out[label];
  expect(res?.status, `${label}: ${JSON.stringify(res)}`).toBe(200);
  expect(res.isError, `${label}: ${JSON.stringify(res.value)}`).toBe(false);
  return res.value;
};
const compat = (label: string, code: string, path?: string) => {
  const res = out[label];
  expect(res?.status, `${label}: ${JSON.stringify(res)}`).toBe(200);
  expect(res.isError, `${label}: ${JSON.stringify(res.value)}`).toBe(true);
  expect(res.value.compat).toMatchObject({ version: "arra-v3-compat/1", code });
  if (path !== undefined) expect(res.value.compat.path).toBe(path);
  return res.value;
};
const peersOf = (label: string) => ok(label).rows.map((r: any) => r.peer_name);
/** A kernel refusal through kb_*: the governed envelope, on whichever layer answered it. */
const kbRefused = (label: string, code: string, path: string) => {
  const res = out[label];
  const where = `${label}: ${JSON.stringify(res)}`;
  if (res?.status === 200) {
    expect(res.isError, where).toBe(true);
    expect(res.value, where).toMatchObject({ code, path });
  } else {
    expect(res?.status, where).toBe(code === "forbidden" ? 403 : 400);
    const body = JSON.stringify(res.body ?? res.value);
    expect(body, where).toContain(`"${code}"`);
    expect(body, where).toContain(`"${path}"`);
  }
};

describe("an idempotency_key is the speaker's own, and never joins anyone silently", () => {
  test("another speaker's same key starts ITS OWN thread; the first thread gains no member and leaks nothing", () => {
    const neo = ok("shared_neo");
    // The verifier's repro: before the fix nat's call was refused, yet had
    // already joined nat and zoe to neo's thread, and both read it.
    expect(peersOf("shared_ts_members")).toEqual(["neo"]);
    for (const label of ["shared_nat_read", "shared_zoe_read"]) {
      expect(JSON.stringify(out[label])).not.toContain("neo private body");
      compat(label, "semantic_refusal");
    }
    const nat = ok("shared_nat");
    expect(nat.thread_id).not.toBe(neo.thread_id);
    expect(ok("shared_nat_retry")).toMatchObject({ thread_id: nat.thread_id, message_id: nat.message_id });
    expect(peersOf("shared_tn_members")).toEqual(["nat", "zoe"]);
  });

  test("a keyed thread that already exists without the speaker is refused before anyone is joined or anything posted", () => {
    expect(ok("squat_register").outcome).toBe("created");
    compat("squat_post", "semantic_refusal", "/idempotency_key");
    expect(peersOf("squat_members")).toEqual([]);
    expect(ok("squat_audit_read").messages).toEqual([]);
  });
});

describe("continuing a closed thread is a member's act", () => {
  test("a stranger's reopen is refused, writes nothing, and carries no one anywhere", () => {
    ok("tx_close");
    expect(compat("ghosty_reopen", "semantic_refusal", "/threadId").error).toContain("member");
    expect(ok("ghosty_peer")).toBeNull();
    expect(ok("ghosty_threads").rows).toEqual([]);
  });

  test("a current member still continues it, carrying the other members over", () => {
    expect(ok("tx_reopen").v4.continues).toBe(out.tx.value.thread_id);
    expect(peersOf("ty_members")).toEqual(["nat", "zoe"]);
  });
});

describe("listSessionMembers is behind the same R3 boundary as the messages", () => {
  test("no requester needs audit:read; a named requester must be bound AND a current member", () => {
    kbRefused("mem_rw_no_requester", "forbidden", "/requester_peer_name");
    kbRefused("mem_rw_nonmember", "invalid_reference", "/requester_peer_name");
    kbRefused("mem_rw_other", "forbidden", "/requester_peer_name");
    expect(peersOf("mem_rw_member")).toEqual(["neo"]);
  });
});

describe("closeSession with no peer is the operator path", () => {
  test("peer_name null needs audit:read: refused for content:write alone, bound or not; a writing operator closes", () => {
    kbRefused("close_null_rw", "forbidden", "/peer_name");
    kbRefused("close_null_free", "forbidden", "/peer_name");
    expect(ok("tc_open").is_active).toBe(true);
    expect(ok("close_null_opw").outcome).toBe("closed");
    const head = ok("tc_closed");
    expect(head.is_active).toBe(false);
    expect(JSON.parse(head.internal_metadata).closed).toMatchObject({ by_peer: null, reason: "operator close", operation_id: "null-3" });
  });
});

describe("an over-long title is refused before any write", () => {
  test("a title over 1024 UTF-8 bytes is unsupported_argument at /title, and the speaker was not registered", () => {
    compat("long_title", "unsupported_argument", "/title");
    expect(ok("tia_peer")).toBeNull();
  });
});

describe("closeSession and listSessionMembers over HTTP /api/knowledge", () => {
  test("listSessionMembers: a stranger is 400 invalid_reference, a member and the operator read, content:read alone is 403", () => {
    expect(out.http_members_stranger).toMatchObject({ status: 400, value: { code: "invalid_reference", path: "/requester_peer_name" } });
    for (const label of ["http_members_member", "http_members_operator"]) {
      expect(out[label].status, JSON.stringify(out[label])).toBe(200);
      expect(out[label].value.rows.map((r: any) => r.peer_name)).toEqual(["nat"]);
    }
    expect(out.http_members_ro).toMatchObject({ status: 403, value: { code: "forbidden", path: "/requester_peer_name" } });
  });

  test("closeSession: another peer and a peerless non-operator are 403 /peer_name, read-only is 403; a member closes once, then replays", () => {
    expect(out.http_close_other).toMatchObject({ status: 403, value: { code: "forbidden", path: "/peer_name" } });
    expect(out.http_close_null).toMatchObject({ status: 403, value: { code: "forbidden", path: "/peer_name" } });
    expect(out.http_close_ro.status).toBe(403);
    expect(out.http_close_member.status, JSON.stringify(out.http_close_member)).toBe(200);
    expect(out.http_close_member.value.outcome).toBe("closed");
    expect(JSON.parse(out.http_close_member.value.row.internal_metadata).closed).toMatchObject({ by_peer: "nat", reason: HTTP_REASON });
    expect(out.http_close_again.value).toEqual({ outcome: "idempotent", row: out.http_close_member.value.row });
  });
});
