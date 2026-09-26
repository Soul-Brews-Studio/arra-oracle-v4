// Slices V4 + V10 -- the v3 forum family over sessions and messages:
// oracle_thread, oracle_threads, oracle_thread_read, oracle_thread_update
// (docs/overnight/V3-PARITY.md §3 A3/A7/A8, §4.2-§4.4, §7 "V4"/"V10";
// DECISIONS.md R3, R18 D7/D8). Written BEFORE the four tools existed.
//
// Nat's intent: each oracle registers as an entity (a peer) and they talk to
// each other like a Claude Code channel. A thread is a session, a post is a
// message, the speaker is the X-Arra-Peer header bound by the grant's
// `peers`, and membership is the read boundary (R3).
//
// Real gate, real dataset, real wire: `fixtures/v3-compat-v1/core/forum-child.ts`
// boots the production app inside `exec_with_gate` and replays MCP calls with
// no seam. State is read back through `kb_*` on the same app.
//
// v3 forum defects D1-D10 (.tmp/parity/map-forum.md §4) are pinned where they
// could recur: D1 (update succeeds on a missing thread), D5 (an invented role
// default), D6 (a promised auto-answer), D7 (limit dropped), D8 (author from
// the server's cwd), D10 (threads is N+1: no per-thread read here at all).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivedId } from "../src/mcp/legacy-v3/ids.derivedId";
import { runGated } from "./helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "forum-child.ts");
const F = "ws-forum";
const O = "ws-other";
const ref = (name: string) => ({ $ref: name });
/** The session id nat's oracle_thread derives from idempotency_key "squat-key". */
const SQUAT = derivedId(F, "session", "oracle_thread", "nat", "squat-key");
const kb = (label: string, method: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ label, bank: F, tool: `kb_${method}`, args: { payload: { workspace_name: F, ...payload } }, ...extra });
const session = (label: string, name: string) => kb(label, "getSession", { session_name: ref(name) });
// Read back through the audit:read operator view: the member list is behind
// the same R3 boundary as the messages.
const membersAt = (label: string, name: unknown) =>
  kb(label, "listSessionMembers", { session_name: name, after_name: null, limit: 100 }, { as: "audit" });
const members = (label: string, name: string) => membersAt(label, ref(name));
/** The same payload over HTTP `/api/knowledge/<bank>/<method>` (the CLI's route too). */
const http = (label: string, method: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ label, bank: F, tool: `http:${method}`, args: { workspace_name: F, ...payload }, ...extra });
const HTTP_REASON = 'done: \u0e25\u0e37\u0e21 "quoted" \\ ok';
const say = (label: string, peer: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ label, bank: F, peer, tool: "oracle_thread", args, ...extra });
const read = (label: string, peer: string | undefined, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ label, bank: F, ...(peer ? { peer } : {}), tool: "oracle_thread_read", args, ...extra });
const update = (label: string, peer: string | undefined, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ label, bank: F, ...(peer ? { peer } : {}), tool: "oracle_thread_update", args, ...extra });
const threads = (label: string, peer: string | undefined, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ label, bank: F, ...(peer ? { peer } : {}), tool: "oracle_threads", args, ...extra });

let fixture: TaxonomyFixture;
let work: string;
let out: Record<string, any> = {};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-forum-"));
  await mkdir(join(work, "legacy"));
  fixture = await createTaxonomyFixture([F, O]);
  const steps = [
    // V4 #1 and the refusals that must precede any write.
    { label: "no_speaker", bank: F, tool: "oracle_thread", args: { message: "hello" } },
    say("blank", "neo", { message: "   " }),
    { label: "unbound_arg", bank: F, tool: "oracle_thread", args: { message: "x", peer: "nat" } },
    say("rw_to_nat", "neo", { message: "x", to: ["nat"] }),
    say("to_ghost", "nat", { message: "x", to: ["ghost"] }, { as: "free" }),
    kb("count0", "listSessions", { after_name: null, limit: 100, include_total: true }),
    // V4 #2: a new thread.
    say("new", "neo", { message: "Birth thread body", title: "birth", model: "opus", idempotency_key: "k-new" }, { capture: { name: "TH1", path: ["thread_id"] } }),
    say("new_retry", "neo", { message: "Birth thread body", title: "birth", model: "opus", idempotency_key: "k-new" }),
    say("new_reuse", "neo", { message: "different body", idempotency_key: "k-new" }),
    session("head_th1", "TH1"),
    kb("neo_peer", "getPeer", { peer_name: "neo" }),
    read("read1", "neo", { threadId: ref("TH1") }),
    // V4 #3: a non-member is refused and never joined silently; join:true joins.
    say("nat_post", "nat", { threadId: ref("TH1"), message: "from nat" }, { as: "free" }),
    read("nat_read", "nat", { threadId: ref("TH1") }, { as: "free" }),
    members("members_before_join", "TH1"),
    say("nat_join", "nat", { threadId: ref("TH1"), message: "joining", join: true, role: "oracle" }, { as: "free" }),
    read("read2", "neo", { threadId: ref("TH1") }),
    // V4 #4: reading never moves a read cursor; the speaker is the reader.
    kb("cursor", "getReadCursor", { peer_name: "neo", session_name: ref("TH1") }),
    read("ro_read", "nat", { threadId: ref("TH1") }, { as: "ro" }),
    read("ro_no_speaker", undefined, { threadId: ref("TH1") }, { as: "ro" }),
    read("audit_read", undefined, { threadId: ref("TH1") }, { as: "audit" }),
    say("ro_write", "nat", { message: "x" }, { as: "ro" }),
    // V4 #5: v3 ids never resolve; an unknown or other-bank name is not found.
    read("legacy_read", "neo", { threadId: 42 }),
    say("legacy_post", "neo", { threadId: 42, message: "x" }),
    update("legacy_update", "neo", { threadId: 42, status: "closed" }),
    read("missing_read", "neo", { threadId: "t-nope" }),
    read("other_bank_read", "neo", { threadId: ref("TH1") }, { bank: O }),
    // V4 #6: stored statuses v4 does not have; D1 (missing thread is an error).
    update("answered", "neo", { threadId: ref("TH1"), status: "answered" }),
    update("pending", "neo", { threadId: ref("TH1"), status: "pending" }),
    update("update_missing", "neo", { threadId: "t-nope", status: "closed" }),
    update("update_bogus", "neo", { threadId: ref("TH1"), status: "archived" }),
    update("update_active", "neo", { threadId: ref("TH1"), status: "active" }),
    // V10: the tail of a longer thread.
    say("post3", "neo", { threadId: ref("TH1"), message: "m3" }),
    say("post4", "neo", { threadId: ref("TH1"), message: "m4" }),
    say("post5", "neo", { threadId: ref("TH1"), message: "m5" }),
    read("tail", "neo", { threadId: ref("TH1"), limit: 2 }),
    read("tail_all", "neo", { threadId: ref("TH1"), limit: 10 }),
    // V10: threads, filtered by membership.
    say("th2", "nat", { message: "nat alone", title: "nat's" }, { as: "free", capture: { name: "TH2", path: ["thread_id"] } }),
    // A stranger's refused post adds nobody, `to` included.
    say("stranger_invite", "zoe", { threadId: ref("TH2"), message: "let me add neo", to: ["neo"] }, { as: "free" }),
    members("th2_members", "TH2"),
    // ...and writes nothing at all: zoe is not even registered by trying.
    kb("zoe_after_refusal", "getPeer", { peer_name: "zoe" }),
    threads("threads_neo", "neo", { limit: 20 }),
    threads("threads_neo_all", "neo", { limit: 20, all: true }),
    threads("threads_nat", "nat", {}, { as: "free" }),
    threads("threads_audit", undefined, {}, { as: "audit" }),
    threads("threads_offset", "neo", { offset: 5 }),
    threads("threads_answered", "neo", { status: "answered" }),
    // Closing needs a speaking member.
    update("zed_close", "zed", { threadId: ref("TH2"), status: "closed" }, { as: "free" }),
    update("close_no_speaker", undefined, { threadId: ref("TH2"), status: "closed" }),
    session("head_th2", "TH2"),
    // V10: close, then everything a closed thread refuses.
    update("close", "neo", { threadId: ref("TH1"), status: "closed" }),
    session("head_closed", "TH1"),
    update("close_again", "neo", { threadId: ref("TH1"), status: "closed" }),
    say("post_closed", "neo", { threadId: ref("TH1"), message: "after close" }),
    kb("kb_append_closed", "appendMessages", { session_name: ref("TH1"), items: [{ public_id: "sneakysneakysneaky000", message: { peer_name: "neo", role: null, content: "sneak", in_reply_to: null }, source: null }] }),
    update("active_on_closed", "neo", { threadId: ref("TH1"), status: "active" }),
    threads("threads_active", "neo", { status: "active", all: true }),
    threads("threads_closed", "neo", { status: "closed", all: true }),
    read("read_closed", "neo", { threadId: ref("TH1") }),
    // V4 #7: reopen is a NEW session continuing the old one.
    say("reopen", "neo", { threadId: ref("TH1"), message: "reopened", reopen: true }, { capture: { name: "TH3", path: ["thread_id"] } }),
    kb("links", "listSessionLinks", { session_name: ref("TH3"), direction: "from", cursor: null, limit: 10 }),
    members("th3_members", "TH3"),
    read("th3_read", "neo", { threadId: ref("TH3") }),
    // An unbound credential carries the members over.
    say("th4", "nat", { message: "to neo", to: ["neo"], title: "pair" }, { as: "free", capture: { name: "TH4", path: ["thread_id"] } }),
    update("th4_close", "nat", { threadId: ref("TH4"), status: "closed" }, { as: "free" }),
    say("th4_reopen", "nat", { threadId: ref("TH4"), message: "again", reopen: true }, { as: "free", capture: { name: "TH5", path: ["thread_id"] } }),
    members("th5_members", "TH5"),
    session("th5_head", "TH5"),
    kb("count_end", "listSessions", { after_name: null, limit: 100, include_total: true }),
    // Fix round (the verifier's findings on this slice). An idempotency_key is
    // the SPEAKER's: another speaker's same key must neither land in the first
    // speaker's thread nor join anyone to it.
    say("zoe_hello", "zoe", { message: "zoe registers by speaking" }, { as: "free" }),
    say("shared_neo", "neo", { message: "neo private body", idempotency_key: "shared" }, { capture: { name: "TS", path: ["thread_id"] } }),
    say("shared_nat", "nat", { message: "nat new thread", idempotency_key: "shared", to: ["zoe"] }, { as: "free", capture: { name: "TN", path: ["thread_id"] } }),
    say("shared_nat_retry", "nat", { message: "nat new thread", idempotency_key: "shared", to: ["zoe"] }, { as: "free" }),
    members("shared_ts_members", "TS"),
    members("shared_tn_members", "TN"),
    read("shared_nat_read", "nat", { threadId: ref("TS") }, { as: "free" }),
    read("shared_zoe_read", "zoe", { threadId: ref("TS") }, { as: "free" }),
    // A thread the key derives that already exists WITHOUT the speaker (here
    // pre-registered under that name) is refused before anyone is joined.
    kb("squat_register", "registerSession", { session_id: SQUAT, name: `t-${SQUAT}` }),
    say("squat_post", "nat", { message: "into the squat", idempotency_key: "squat-key", to: ["zoe"] }, { as: "free" }),
    membersAt("squat_members", `t-${SQUAT}`),
    read("squat_audit_read", undefined, { threadId: `t-${SQUAT}` }, { as: "audit" }),
    // Continuing a closed thread is a member's act, and a refusal writes nothing.
    say("ghosty_reopen", "ghosty", { threadId: ref("TH4"), message: "i was never here", reopen: true }, { as: "free" }),
    kb("ghosty_peer", "getPeer", { peer_name: "ghosty" }),
    kb("ghosty_threads", "listSessions", { after_name: null, limit: 100, include_total: false, member_peer_name: "ghosty" }, { as: "audit" }),
    // The member list is behind the R3 boundary: rw is bound to neo, no audit:read.
    kb("mem_rw_no_requester", "listSessionMembers", { session_name: ref("TH2"), after_name: null, limit: 100 }),
    kb("mem_rw_nonmember", "listSessionMembers", { session_name: ref("TH2"), after_name: null, limit: 100, requester_peer_name: "neo" }),
    kb("mem_rw_other", "listSessionMembers", { session_name: ref("TH2"), after_name: null, limit: 100, requester_peer_name: "nat" }),
    kb("mem_rw_member", "listSessionMembers", { session_name: ref("TH3"), after_name: null, limit: 100, requester_peer_name: "neo" }),
    // Closing with no peer is the operator path: it needs audit:read.
    say("tc", "nat", { message: "to be closed by an operator" }, { as: "free", capture: { name: "TC", path: ["thread_id"] } }),
    kb("close_null_rw", "closeSession", { session_name: ref("TC"), reason: "gotcha", peer_name: null, operation_id: "null-1" }),
    kb("close_null_free", "closeSession", { session_name: ref("TC"), reason: "gotcha", peer_name: null, operation_id: "null-2" }, { as: "free" }),
    session("tc_open", "TC"),
    kb("close_null_opw", "closeSession", { session_name: ref("TC"), reason: "operator close", peer_name: null, operation_id: "null-3" }, { as: "opw" }),
    session("tc_closed", "TC"),
    // A title over the kernel's 1024-byte cap is refused before any write
    // (513 two-byte characters: bytes, not characters, are counted).
    say("long_title", "tia", { message: "x", title: "\u00e9".repeat(513) }, { as: "free" }),
    kb("tia_peer", "getPeer", { peer_name: "tia" }),
    // The two K9/K10 kernels over HTTP too (the live probe has no fixture for them).
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
    { label: "list_rw", bank: F, tool: "tools/list", args: {} },
    { label: "list_ro", bank: F, as: "ro", tool: "tools/list", args: {} },
  ];
  const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, work, JSON.stringify({ banks: [F, O], steps })], {
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
  expect(res.value.success).toBe(false);
  expect(res.value.compat).toMatchObject({ version: "arra-v3-compat/1", code });
  expect(res.value.compat.tool).toMatch(/^oracle_thread/);
  if (path !== undefined) expect(res.value.compat.path).toBe(path);
  expect(typeof res.value.error).toBe("string");
  return res.value;
};
const warned = (value: any, code: string, field: string) =>
  expect(value.compat_warnings, JSON.stringify(value.compat_warnings)).toContainEqual(expect.objectContaining({ code, field }));
const ids = (value: any) => value.threads.map((t: any) => t.id).sort();

describe("V4 #1: forum writes need a speaker, and refusals come before any write", () => {
  test("no speaker is speaker_required; a blank message, an unbound peer argument and an unbound or unknown `to` are refused", () => {
    compat("no_speaker", "speaker_required");
    compat("blank", "unsupported_argument", "/message");
    compat("unbound_arg", "unsupported_argument", "/peer");
    compat("rw_to_nat", "unsupported_argument", "/to/0");
    compat("to_ghost", "unsupported_argument", "/to/0");
    expect(ok("count0").total).toBe("0");
  });
});

describe("V4 #2: a new thread is a session with the speaker as member and author", () => {
  test("thread_id is the session name (a string); the title is K12a display metadata; model is named as ignored", () => {
    const res = ok("new");
    expect(typeof res.thread_id).toBe("string");
    expect(res.thread_id).toMatch(/^t-[A-Za-z0-9_-]{21}$/);
    expect(typeof res.message_id).toBe("string");
    expect(res).toMatchObject({ status: "active", oracle_response: null, issue_url: null });
    warned(res, "argument_ignored", "model");
    const head = ok("head_th1");
    expect(head).toMatchObject({ name: res.thread_id, is_active: true, h_metadata: JSON.stringify({ title: "birth" }) });
    expect(ok("neo_peer").name).toBe("neo");
  });

  test("the same idempotency_key replays instead of duplicating; reused for other content it is refused", () => {
    expect(ok("new_retry")).toMatchObject({ thread_id: out.new.value.thread_id, message_id: out.new.value.message_id });
    compat("new_reuse", "semantic_refusal", "/idempotency_key");
    expect(ok("read1").messages.map((m: any) => m.content)).toEqual(["Birth thread body"]);
  });

  test("thread_read answers v3's shape: title, status, exact count, author = the peer, no invented role (D5)", () => {
    const res = ok("read1");
    expect(res).toMatchObject({ thread_id: out.new.value.thread_id, title: "birth", status: "active", message_count: 1 });
    expect(res.messages[0]).toMatchObject({ id: out.new.value.message_id, author: "neo", role: null, content: "Birth thread body" });
    expect(typeof res.messages[0].timestamp).toBe("string");
    warned(res, "field_unavailable", "messages[].role");
  });
});

describe("V4 #3 and #4: membership is the boundary; no silent join; reads move no cursor", () => {
  test("a non-member cannot post or read, and was not joined by trying", () => {
    compat("nat_post", "semantic_refusal");
    expect(out.nat_post.value.error).toContain("join:true");
    compat("nat_read", "semantic_refusal");
    expect(ok("members_before_join").rows.map((r: any) => r.peer_name)).toEqual(["neo"]);
  });

  test("a stranger's refused post adds no one: recipients join only after the post proves the speaker a member", () => {
    compat("stranger_invite", "semantic_refusal");
    expect(out.stranger_invite.value.error).toContain("join:true");
    expect(ok("th2_members").rows.map((r: any) => r.peer_name)).toEqual(["nat"]);
    // Fix round: the membership refusal comes before the speaker is registered.
    expect(ok("zoe_after_refusal")).toBeNull();
  });

  test("join:true joins and posts; the thread reads back in seq order with each author and role", () => {
    ok("nat_join");
    const res = ok("read2");
    expect(res.messages.map((m: any) => [m.author, m.role, m.content])).toEqual([["neo", null, "Birth thread body"], ["nat", "oracle", "joining"]]);
    expect(Number(res.messages[0].seq)).toBeLessThan(Number(res.messages[1].seq));
  });

  test("reading never moves the read cursor", () => {
    expect(ok("cursor")).toBeNull();
  });

  test("a read-only credential reads as its asserted peer; with no speaker only the audit:read operator view reads", () => {
    expect(ok("ro_read").messages).toHaveLength(2);
    compat("ro_no_speaker", "speaker_required");
    expect(ok("audit_read").messages).toHaveLength(2);
    expect(out.ro_write.status).toBe(403);
  });
});

describe("V4 #5 and #6: ids, statuses and D1", () => {
  test("a v3 integer threadId is legacy_id_unknown on every forum tool; an unknown or other-bank name is not found", () => {
    compat("legacy_read", "legacy_id_unknown", "/threadId");
    compat("legacy_post", "legacy_id_unknown", "/threadId");
    compat("legacy_update", "legacy_id_unknown", "/threadId");
    compat("missing_read", "no_results");
    expect(out.missing_read.value.error).toContain("t-nope");
    compat("other_bank_read", "no_results");
  });

  test("answered and pending are the documented semantic_refusal; a missing thread is never a success (D1)", () => {
    compat("answered", "semantic_refusal", "/status");
    compat("pending", "semantic_refusal", "/status");
    compat("update_missing", "no_results");
    compat("update_bogus", "unsupported_argument", "/status");
    expect(ok("update_active")).toMatchObject({ success: true, thread_id: out.new.value.thread_id, status: "active" });
  });
});

describe("V10: tail read of the last N (K11), honouring limit (D7)", () => {
  test("limit N returns the LAST N in seq order; the count is null and named when the tail did not reach the start", () => {
    const res = ok("tail");
    expect(res.messages.map((m: any) => m.content)).toEqual(["m4", "m5"]);
    expect(res.message_count).toBeNull();
    warned(res, "field_unavailable", "message_count");
  });

  test("a limit that covers the whole thread returns all of it with an exact count", () => {
    const res = ok("tail_all");
    expect(res.messages.map((m: any) => m.content)).toEqual(["Birth thread body", "joining", "m3", "m4", "m5"]);
    expect(res.message_count).toBe(5);
  });
});

describe("V10: oracle_threads, filtered by membership (K10), never N+1 (D10)", () => {
  test("with a speaker the list is that speaker's threads, and says so; all:true lists every thread", () => {
    const neo = ok("threads_neo");
    expect(ids(neo)).toEqual([out.new.value.thread_id]);
    warned(neo, "semantic_change", "threads");
    expect(ids(ok("threads_neo_all"))).toEqual([out.new.value.thread_id, out.th2.value.thread_id].sort());
    expect(ids(ok("threads_nat"))).toEqual([out.new.value.thread_id, out.th2.value.thread_id].sort());
    expect(ids(ok("threads_audit"))).toEqual([out.new.value.thread_id, out.th2.value.thread_id].sort());
  });

  test("each row is v3's shape: title and created_at filled, count and last message null and named, order named", () => {
    const res = ok("threads_neo_all");
    const th2 = res.threads.find((t: any) => t.id === out.th2.value.thread_id);
    expect(th2).toMatchObject({ title: "nat's", status: "active", message_count: null, last_message: null, issue_url: null });
    expect(typeof th2.created_at).toBe("string");
    expect(res.total).toBe(2);
    warned(res, "field_unavailable", "message_count");
    warned(res, "field_unavailable", "last_message");
    warned(res, "order_changed", "threads");
  });

  test("offset is unsupported (keyset cursors); answered is a semantic_refusal", () => {
    compat("threads_offset", "unsupported_argument", "/offset");
    compat("threads_answered", "semantic_refusal", "/status");
  });
});

describe("V10: oracle_thread_update closed is K9 closeSession (D7)", () => {
  test("closing needs a speaking member: a stranger is refused, no speaker is speaker_required, and the thread stays open", () => {
    compat("zed_close", "semantic_refusal");
    compat("close_no_speaker", "speaker_required");
    expect(ok("head_th2").is_active).toBe(true);
  });

  test("close records who and why in internal_metadata; closing again is the same answer with no second record", () => {
    expect(ok("close")).toMatchObject({ success: true, thread_id: out.new.value.thread_id, status: "closed" });
    const head = ok("head_closed");
    expect(head.is_active).toBe(false);
    const closed = JSON.parse(head.internal_metadata).closed;
    expect(closed).toMatchObject({ by_peer: "neo" });
    expect(typeof closed.reason).toBe("string");
    expect(ok("close_again")).toMatchObject({ success: true, status: "closed" });
  });

  test("a closed thread refuses posts (with a pointer at reopen), refuses a raw append, and cannot be set active", () => {
    const refused = compat("post_closed", "semantic_refusal");
    expect(refused.error).toContain("reopen");
    expect(ok("kb_append_closed")).toMatchObject({ outcome: "stopped", stop: { error: { code: "invalid_reference", path: "/session_name" } } });
    expect(compat("active_on_closed", "semantic_refusal").error).toContain("reopen");
  });

  test("status filters are exact now; the closed thread still reads, as history", () => {
    expect(ids(ok("threads_active"))).toEqual([out.th2.value.thread_id]);
    expect(ids(ok("threads_closed"))).toEqual([out.new.value.thread_id]);
    const res = ok("read_closed");
    expect(res.status).toBe("closed");
    expect(res.messages).toHaveLength(5);
  });
});

describe("V4 #7: reopen continues a closed thread in a NEW session", () => {
  test("a new thread, linked `continues` to the old one, titled like it, named in a warning", () => {
    const res = ok("reopen");
    expect(res.thread_id).not.toBe(out.new.value.thread_id);
    warned(res, "semantic_change", "thread_id");
    const [link] = ok("links").rows;
    expect(link).toMatchObject({ from_session_name: res.thread_id, to_session_name: out.new.value.thread_id, relation: "continues", created_by_peer_name: "neo" });
    expect(ok("th3_read")).toMatchObject({ title: "birth", status: "active", message_count: 1 });
  });

  test("members the credential may not act as are not carried, and the warning names them", () => {
    expect(ok("th3_members").rows.map((r: any) => r.peer_name)).toEqual(["neo"]);
    warned(out.reopen.value, "partial", "members");
    expect(JSON.stringify(out.reopen.value.compat_warnings)).toContain("nat");
  });

  test("an unbound credential carries every current member over", () => {
    ok("th4");
    ok("th4_close");
    ok("th4_reopen");
    expect(ok("th5_members").rows.map((r: any) => r.peer_name).sort()).toEqual(["nat", "neo"]);
    expect(ok("th5_head").h_metadata).toBe(JSON.stringify({ title: "pair" }));
    expect(ok("count_end").total).toBe("5");
  });
});

describe("the four tools are advertised by grant", () => {
  test("rw lists all four; a read-only grant lists only the two reads", () => {
    const rw = out.list_rw.value as string[];
    for (const name of ["oracle_thread", "oracle_threads", "oracle_thread_read", "oracle_thread_update"]) expect(rw).toContain(name);
    const ro = out.list_ro.value as string[];
    expect(ro).toContain("oracle_threads");
    expect(ro).toContain("oracle_thread_read");
    expect(ro).not.toContain("oracle_thread");
    expect(ro).not.toContain("oracle_thread_update");
  });
});

// ── fix round: the independent verifier's findings on this slice ─────────
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

describe("fix round: an idempotency_key is the speaker's own, and never joins anyone silently", () => {
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

describe("fix round: continuing a closed thread is a member's act", () => {
  test("a stranger's reopen is refused, writes nothing, and carries no one anywhere", () => {
    const refused = compat("ghosty_reopen", "semantic_refusal");
    expect(refused.error).toContain("member");
    expect(ok("ghosty_peer")).toBeNull();
    expect(ok("ghosty_threads").rows).toEqual([]);
  });
});

describe("fix round: listSessionMembers is behind the same R3 boundary as the messages", () => {
  test("no requester needs audit:read; a named requester must be bound AND a current member", () => {
    kbRefused("mem_rw_no_requester", "forbidden", "/requester_peer_name");
    kbRefused("mem_rw_nonmember", "invalid_reference", "/requester_peer_name");
    kbRefused("mem_rw_other", "forbidden", "/requester_peer_name");
    expect(peersOf("mem_rw_member")).toEqual(["neo"]);
  });
});

describe("fix round: closeSession with no peer is the operator path", () => {
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

describe("fix round: an over-long title is refused before any write", () => {
  test("a title over 1024 UTF-8 bytes is unsupported_argument at /title, and the speaker was not registered", () => {
    compat("long_title", "unsupported_argument", "/title");
    expect(ok("tia_peer")).toBeNull();
  });
});

describe("fix round: closeSession and listSessionMembers over HTTP /api/knowledge", () => {
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
