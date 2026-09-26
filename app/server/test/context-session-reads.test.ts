/**
 * K10 session filters + membership read, K11 message tail (docs/overnight/
 * V3-PARITY.md §5; DECISIONS.md R18). Written BEFORE any of them existed.
 *
 *  - K10 `listSessions` gains two OPTIONAL filters, `is_active` and
 *    `member_peer_name` (CURRENT members only); `listSessionMembers` is the
 *    first read of `session_peers`.
 *  - K11 `listMessages` gains an OPTIONAL `direction:"desc"` with a
 *    `before_seq` keyset cursor, so "the last N" is one page, not a walk.
 *
 * Every existing request shape is unchanged. Real kernel, fresh mkdtemp
 * dataset, real writer gate; nothing below the facade is faked.
 *
 * Layout (alpha):
 *   s1 active   peer-a            messages 1..5 by peer-a
 *   s2 CLOSED   peer-a, peer-b
 *   s3 active   peer-b
 *   s4 CLOSED   peer-a
 *   s5 active   peer-a (LEFT)
 * beta mirrors the names with peer-a in s3 only, so a read that dropped its
 * workspace clause shows visibly wrong rows.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import { parseListMessages, parseListSessions } from "../src/publication/context";
import { appendRequest, contextId, createContextFixture, messageItem, type ContextFixture } from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";
import { OPERATOR, READER, driveContext, op } from "./helpers/read-boundary-fixture";

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const TIMEOUT = 300_000;
const RAW_MUTATE = new URL("./fixtures/context-v1/ownership/raw-mutate.ts", import.meta.url).pathname;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const contractErr = (run: () => unknown): ContractError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw new Error(`expected ContractError, got ${(error as Error)?.name}: ${String(error)}`);
  }
  throw new Error("expected a throw, got none");
};

const sessions = (extra: Record<string, unknown> = {}, workspace = ALPHA) => ({
  workspace_name: workspace, after_name: null, limit: 100, include_total: false, ...extra,
});
const members = (session: string, extra: Record<string, unknown> = {}, workspace = ALPHA) => ({
  workspace_name: workspace, session_name: session, after_name: null, limit: 100, ...extra,
});
const tail = (extra: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA, session_name: "s1", after_seq: null, limit: 2, direction: "desc", before_seq: null,
  requester_peer_name: "peer-a", ...extra,
});

const names = (result: any): string[] => {
  expect(result?.ok, JSON.stringify(result)).toBe(true);
  return result.value.rows.map((row: { name: string }) => row.name);
};
const refused = (result: any, code: string, path: string, version = "arra-publication-error/v1") => {
  expect(result?.ok, `expected ${code} at ${path}, got ${JSON.stringify(result)}`).toBe(false);
  expect({ code: result.code, path: result.path, version: result.version }).toEqual({ code, path, version });
};

describe("grammar (pure): every new key is optional, every old shape unchanged", () => {
  test("listSessions: is_active is boolean|null, member_peer_name a nullable name; absent reads back as null", () => {
    const base = sessions();
    expect(parseListSessions(bytes(base))).toMatchObject({ is_active: null, member_peer_name: null });
    expect(parseListSessions(bytes({ ...base, is_active: false, member_peer_name: "peer-a" }))).toMatchObject({ is_active: false, member_peer_name: "peer-a" });
    expect(contractErr(() => parseListSessions(bytes({ ...base, is_active: "true" }))).path).toBe("/is_active");
    expect(contractErr(() => parseListSessions(bytes({ ...base, member_peer_name: "" }))).path).toBe("/member_peer_name");
    expect(contractErr(() => parseListSessions(bytes({ ...base, member: "peer-a" }))).code).toBe("unexpected_field");
  });

  test("listSessions: a total over BOTH filters is not countable and is refused, not approximated", () => {
    const e = contractErr(() => parseListSessions(bytes(sessions({ include_total: true, is_active: true, member_peer_name: "peer-a" }))));
    expect({ code: e.code, path: e.path }).toEqual({ code: "invalid_value", path: "/include_total" });
  });

  test("listMessages: direction asc|desc; before_seq only with desc; after_seq only with asc", () => {
    const asc = { workspace_name: ALPHA, session_name: "s1", after_seq: null, limit: 10 };
    expect(parseListMessages(bytes(asc))).toMatchObject({ direction: "asc", before_seq: null });
    expect(parseListMessages(bytes(tail({ before_seq: "4" })))).toMatchObject({ direction: "desc", before_seq: "4" });
    expect(contractErr(() => parseListMessages(bytes({ ...asc, direction: "sideways" }))).path).toBe("/direction");
    expect(contractErr(() => parseListMessages(bytes({ ...asc, before_seq: "4" }))).path).toBe("/before_seq");
    expect(contractErr(() => parseListMessages(bytes(tail({ after_seq: "1" })))).path).toBe("/after_seq");
    expect(contractErr(() => parseListMessages(bytes(tail({ before_seq: 4 })))).path).toBe("/before_seq");
  });
});

let fixture: ContextFixture;
let run: Record<string, any>;

beforeAll(async () => {
  fixture = await createContextFixture([ALPHA, BETA]);
  const seed: ReturnType<typeof op>[] = [];
  for (const workspace of [ALPHA, BETA]) {
    for (const peer of ["peer-a", "peer-b"]) seed.push(op("registerPeer", { workspace_name: workspace, peer_id: contextId(peer), name: peer }));
    for (const name of ["s1", "s2", "s3", "s4", "s5"]) seed.push(op("registerSession", { workspace_name: workspace, session_id: contextId(name), name }));
  }
  const joins: Array<[string, string]> = [["s1", "peer-a"], ["s2", "peer-a"], ["s2", "peer-b"], ["s3", "peer-b"], ["s4", "peer-a"], ["s5", "peer-a"]];
  for (const [name, peer] of joins) seed.push(op("joinSession", { workspace_name: ALPHA, session_name: name, peer_name: peer }));
  seed.push(op("joinSession", { workspace_name: BETA, session_name: "s3", peer_name: "peer-a" }));
  for (let i = 1; i <= 5; i++) {
    seed.push(op("appendMessages", appendRequest(ALPHA, "s1", [messageItem({ public_id: contextId(`s1m${i}`), message: { content: `m${i}` } })])));
  }
  const seeded = await driveContext(fixture.datasetRoot, seed);
  for (let i = 0; i < seed.length; i++) {
    if (seeded[`op${i}`]?.ok !== true) throw new Error(`seed op${i} ${seed[i]!.method}: ${JSON.stringify(seeded[`op${i}`])}`);
  }
  // Closed sessions and a departed member are staged with the raw gated
  // connection, so these reads are tested independently of K9's own writer.
  const raw = async (...args: string[]) => {
    const result = await runGated(fixture.datasetRoot, RAW_MUTATE, [args[0]!, fixture.datasetRoot, ALPHA, ...args.slice(1)]);
    if (result.code !== 0 || !result.stdout.includes("EVENT done")) throw new Error(`raw ${args.join(" ")}: ${result.stderr.slice(0, 600)}`);
  };
  await raw("deactivate-session", "s2");
  await raw("deactivate-session", "s4");
  await raw("leave-membership", "s5", "peer-a");

  run = await driveContext(fixture.datasetRoot, [
    op("listSessions", sessions()), // 0 unchanged shape
    op("listSessions", sessions({ is_active: true, include_total: true })), // 1
    op("listSessions", sessions({ is_active: false, include_total: true })), // 2
    op("listSessions", sessions({ member_peer_name: "peer-a", include_total: true })), // 3
    op("listSessions", sessions({ member_peer_name: "peer-a", limit: 2 })), // 4
    op("listSessions", sessions({ member_peer_name: "peer-a", limit: 2, after_name: "s2" })), // 5
    op("listSessions", sessions({ member_peer_name: "peer-a", is_active: true })), // 6
    op("listSessions", sessions({ member_peer_name: "peer-a", is_active: false })), // 7
    op("listSessions", sessions({ member_peer_name: "nobody" })), // 8
    op("listSessions", sessions({ member_peer_name: "peer-a" }, BETA)), // 9
    op("listSessionMembers", members("s2")), // 10
    op("listSessionMembers", members("s2", { limit: 1 })), // 11
    op("listSessionMembers", members("s2", { limit: 1, after_name: "peer-a" })), // 12
    op("listSessionMembers", members("s5")), // 13 departed member is history, flagged by left_at
    op("listSessionMembers", members("nope")), // 14
    op("listSessionMembers", members("s2", {}, BETA)), // 15
    op("listMessages", tail(), READER), // 16 last two
    op("listMessages", tail({ before_seq: "4" }), READER), // 17
    op("listMessages", tail({ before_seq: "2" }), READER), // 18
    op("listMessages", tail({ requester_peer_name: "peer-b" }), READER), // 19 non-member
    op("listMessages", tail({ requester_peer_name: null }), READER), // 20 no requester, no operator
    op("listMessages", tail({ requester_peer_name: null, limit: 100 }), OPERATOR), // 21 operator view, all five
    op("listMessages", { workspace_name: ALPHA, session_name: "s1", after_seq: null, limit: 2, direction: "asc", requester_peer_name: "peer-a" }, READER), // 22
  ]);
}, TIMEOUT);
afterAll(async () => {
  await fixture?.cleanup();
});

describe("K10 listSessions filters", () => {
  test("a request without the new keys pages exactly as before", () => {
    expect(names(run.op0)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(run.op0.value.next_after_name).toBeNull();
  });

  test("is_active filters inside the page query, so pages are full and total counts the filtered set", () => {
    expect(names(run.op1)).toEqual(["s1", "s3", "s5"]);
    expect(run.op1.value.total).toBe("3");
    expect(names(run.op2)).toEqual(["s2", "s4"]);
    expect(run.op2.value.total).toBe("2");
  });

  test("member_peer_name lists only sessions the peer CURRENTLY belongs to, keyset-paged by name", () => {
    expect(names(run.op3)).toEqual(["s1", "s2", "s4"]);
    expect(run.op3.value.total).toBe("3");
    expect(names(run.op4)).toEqual(["s1", "s2"]);
    expect(run.op4.value.next_after_name).toBe("s2");
    expect(names(run.op5)).toEqual(["s4"]);
    expect(run.op5.value.next_after_name).toBeNull();
  });

  test("both filters combine; an unknown peer is an empty list; the other workspace's memberships never leak", () => {
    expect(names(run.op6)).toEqual(["s1"]);
    expect(names(run.op7)).toEqual(["s2", "s4"]);
    expect(names(run.op8)).toEqual([]);
    expect(names(run.op9)).toEqual(["s3"]);
  });
});

describe("K10 listSessionMembers: the first read of session_peers", () => {
  test("rows are membership rows, ordered by peer name, keyset-paged", () => {
    expect(run.op10.ok).toBe(true);
    expect(run.op10.value.rows.map((r: any) => [r.peer_name, r.left_at])).toEqual([["peer-a", null], ["peer-b", null]]);
    expect(run.op10.value.next_after_name).toBeNull();
    expect(run.op11.value.rows.map((r: any) => r.peer_name)).toEqual(["peer-a"]);
    expect(run.op11.value.next_after_name).toBe("peer-a");
    expect(run.op12.value.rows.map((r: any) => r.peer_name)).toEqual(["peer-b"]);
  });

  test("a departed member stays in the history with left_at set; a missing session is invalid_reference", () => {
    const [row] = run.op13.value.rows;
    expect(row.peer_name).toBe("peer-a");
    expect(typeof row.left_at).toBe("string");
    refused(run.op14, "invalid_reference", "/session_name");
    expect(run.op15.value.rows).toEqual([]);
  });
});

describe("K11 listMessages tail", () => {
  const contents = (result: any) => {
    expect(result?.ok, JSON.stringify(result)).toBe(true);
    return result.value.rows.map((row: { content: string }) => row.content);
  };

  test("direction desc reads the newest first; before_seq pages backward to the start", () => {
    expect(contents(run.op16)).toEqual(["m5", "m4"]);
    expect(run.op16.value.next_before_seq).toBe(run.op16.value.rows[1].seq_in_session);
    expect(contents(run.op17)).toEqual(["m3", "m2"]);
    expect(contents(run.op18)).toEqual(["m1"]);
    expect(run.op18.value.next_before_seq).toBeNull();
    expect("next_after_seq" in run.op16.value).toBe(false);
  });

  test("the R3 membership boundary holds on the tail exactly as on the forward read", () => {
    refused(run.op19, "invalid_reference", "/requester_peer_name");
    refused(run.op20, "forbidden", "/requester_peer_name");
    expect(contents(run.op21)).toEqual(["m5", "m4", "m3", "m2", "m1"]);
  });

  test("an explicit direction asc is the forward read, unchanged", () => {
    expect(contents(run.op22)).toEqual(["m1", "m2"]);
    expect(run.op22.value.next_after_seq).toBe(run.op22.value.rows[1].seq_in_session);
  });

  test("both facades carry listSessionMembers", () => {
    expect(run.contextMethods).toContain("listSessionMembers");
  });
});
