/**
 * K9 `closeSession` and K12a session titles (docs/overnight/V3-PARITY.md §5;
 * DECISIONS.md R18 D7). Written BEFORE either existed.
 *
 * D7: a session can be closed, ONE WAY, and the close is recorded in
 * `sessions.internal_metadata` -- no new column, no new table. K12a:
 * `registerSession` may carry a display title in `h_metadata`; the name stays
 * the immutable identity (DESIGN.md:369).
 *
 * Real kernel, fresh mkdtemp dataset, real writer gate (`gated-context.ts`).
 * Nothing below the facade is faked.
 *
 * Contract: app/docs/contracts/context-ingestion-v1.md, amendment of
 * 2026-09-26 (overnight R18).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import * as context from "../src/publication/context";
import { appendRequest, contextId, createContextFixture, messageItem, type ContextFixture } from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";
import { driveContext, op } from "./helpers/read-boundary-fixture";

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const CLOCK_ISO = "2026-09-21T00:00:00.000Z";
const TIMEOUT = 300_000;
const RAW_MUTATE = new URL("./fixtures/context-v1/ownership/raw-mutate.ts", import.meta.url).pathname;
const TITLE = 'Birth thread: ลืม "quoted"';
const REASON = "done: it's \\ ok ลืม";

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
const parseClose = (value: unknown) => (context as Record<string, any>).parseCloseSession(bytes(value));

const session = (name: string, extra: Record<string, unknown> = {}) => ({ workspace_name: ALPHA, session_id: contextId(name), name, ...extra });
const close = (name: string, extra: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA, session_name: name, reason: REASON, peer_name: "peer-a", operation_id: "close-1", ...extra,
});
/** The stored close record, as canonical JSON text: keys sorted, as JCS sorts them. */
const record = (byPeer: string | null, operationId: string, reason = REASON, others: Record<string, unknown> = {}) => {
  const all: Record<string, unknown> = { ...others, closed: { at: CLOCK_ISO, by_peer: byPeer, operation_id: operationId, reason } };
  return JSON.stringify(Object.fromEntries(Object.keys(all).sort().map((key) => [key, all[key]])));
};

const refused = (result: any, code: string, path: string, version = "arra-publication-error/v1") => {
  expect(result?.ok, `expected ${code} at ${path}, got ${JSON.stringify(result)}`).toBe(false);
  expect({ code: result.code, path: result.path, version: result.version }).toEqual({ code, path, version });
};
const value = (result: any) => {
  expect(result?.ok, JSON.stringify(result)).toBe(true);
  return result.value;
};

describe("grammar (pure)", () => {
  test("closeSession is closed: reason nonempty, peer_name nullable, operation_id a nonempty string", () => {
    expect(parseClose(close("s"))).toEqual(close("s"));
    expect(parseClose(close("s", { peer_name: null })).peer_name).toBeNull();
    for (const [field, bad] of [["reason", ""], ["reason", null], ["operation_id", ""], ["operation_id", 7], ["peer_name", ""], ["session_name", ""]] as const) {
      const e = contractErr(() => parseClose(close("s", { [field]: bad })));
      expect(e.toJSON().version).toBe("arra-error/v1");
      expect(e.path).toBe(`/${field}`);
    }
    expect(contractErr(() => parseClose({ ...close("s"), is_active: false })).code).toBe("unexpected_field");
    expect(contractErr(() => parseClose(close("s", { reason: "x".repeat(4097) }))).path).toBe("/reason");
  });

  test("registerSession h_metadata is OPTIONAL: absent or null is no title; {title} is canonical JSON text", () => {
    const base = session("s");
    expect(context.parseRegisterSession(bytes(base)).h_metadata).toBeNull();
    expect(context.parseRegisterSession(bytes({ ...base, h_metadata: null })).h_metadata).toBeNull();
    expect(context.parseRegisterSession(bytes({ ...base, h_metadata: { title: TITLE } })).h_metadata).toBe(JSON.stringify({ title: TITLE }));
    for (const [bad, path] of [
      [{}, "/h_metadata/title"],
      [{ title: "" }, "/h_metadata/title"],
      [{ title: 5 }, "/h_metadata/title"],
      [{ title: "x".repeat(1025) }, "/h_metadata/title"],
      [{ title: "t", model: "m" }, "/h_metadata/model"],
      ["{\"title\":\"t\"}", "/h_metadata"],
    ] as const) {
      const e = contractErr(() => context.parseRegisterSession(bytes({ ...base, h_metadata: bad })));
      expect({ path: e.path, version: e.toJSON().version }).toEqual({ path, version: "arra-error/v1" });
    }
  });
});

let fixture: ContextFixture;
let run: Record<string, any>;
let replay: Record<string, any>;
let legacy: Record<string, any>;
let corrupt: Record<string, any>;

beforeAll(async () => {
  fixture = await createContextFixture([ALPHA, BETA]);
  const ops = [
    op("registerPeer", { workspace_name: ALPHA, peer_id: contextId("peer-a"), name: "peer-a" }), // 0
    op("registerPeer", { workspace_name: ALPHA, peer_id: contextId("peer-b"), name: "peer-b" }), // 1
    op("registerSession", session("sess-a", { h_metadata: { title: TITLE } })), // 2
    op("registerSession", session("sess-a", { h_metadata: { title: "a different title" } })), // 3
    op("registerSession", session("sess-b")), // 4
    op("registerSession", session("sess-c", { h_metadata: null })), // 5
    op("joinSession", { workspace_name: ALPHA, session_name: "sess-a", peer_name: "peer-a" }), // 6
    op("appendMessages", appendRequest(ALPHA, "sess-a", [messageItem({ public_id: contextId("m1") })])), // 7
    op("closeSession", close("sess-a", { peer_name: "peer-b" })), // 8 not a member
    op("closeSession", close("sess-a", { peer_name: "ghost" })), // 9 no such peer
    op("closeSession", close("sess-missing")), // 10
    op("closeSession", close("sess-a")), // 11 closes
    op("closeSession", close("sess-a")), // 12 exact replay
    op("closeSession", close("sess-a", { reason: "another reason" })), // 13 same key, other payload
    op("closeSession", close("sess-a", { operation_id: "close-2" })), // 14 already closed
    op("getSession", { workspace_name: ALPHA, session_name: "sess-a" }), // 15
    op("appendMessages", appendRequest(ALPHA, "sess-a", [messageItem({ public_id: contextId("m2") })])), // 16
    op("joinSession", { workspace_name: ALPHA, session_name: "sess-a", peer_name: "peer-b" }), // 17
    op("registerSession", session("sess-a")), // 18 no reactivation
    op("closeSession", close("sess-b", { peer_name: null, operation_id: "close-b" })), // 19 operator close
    op("closeSession", { ...close("sess-a"), workspace_name: BETA }), // 20 isolation
    op("closeSession", close("sess-c", { workspace_name: "no-such-workspace" })), // 21
  ];
  run = await driveContext(fixture.datasetRoot, ops);
  // A fresh owner replays the close: the ORIGINAL record, no boundary fired.
  replay = await driveContext(fixture.datasetRoot, [op("closeSession", close("sess-a"))]);

  // A session deactivated with no close record (a legacy or migrated state),
  // and one whose internal_metadata another writer left in each odd shape.
  const staged = await driveContext(fixture.datasetRoot, [
    op("registerSession", session("sess-legacy")),
    op("registerSession", session("sess-garbage")),
    op("registerSession", session("sess-open-record")),
    op("registerSession", session("sess-other-keys")),
    op("joinSession", { workspace_name: ALPHA, session_name: "sess-other-keys", peer_name: "peer-a" }),
  ]);
  for (let i = 0; i < 5; i++) if (staged[`op${i}`]?.ok !== true) throw new Error(`staging op${i}: ${JSON.stringify(staged[`op${i}`])}`);
  const mutate = async (...args: string[]) => {
    const result = await runGated(fixture.datasetRoot, RAW_MUTATE, [args[0]!, fixture.datasetRoot, ALPHA, ...args.slice(1)]);
    if (result.code !== 0 || !result.stdout.includes("EVENT done")) throw new Error(`raw-mutate ${args[0]}: ${result.stderr.slice(0, 600)}`);
  };
  await mutate("deactivate-session", "sess-legacy");
  await mutate("session-internal-metadata", "sess-garbage", "not json");
  await mutate("session-internal-metadata", "sess-open-record", record("peer-a", "forged"));
  await mutate("session-internal-metadata", "sess-other-keys", JSON.stringify({ imported_from: "v3" }));
  legacy = await driveContext(fixture.datasetRoot, [op("closeSession", close("sess-legacy"))]);
  corrupt = await driveContext(fixture.datasetRoot, [
    op("closeSession", close("sess-garbage")),
    op("closeSession", close("sess-open-record")),
    op("closeSession", close("sess-other-keys")),
    op("getSession", { workspace_name: ALPHA, session_name: "sess-garbage" }),
  ]);
}, TIMEOUT);
afterAll(async () => {
  await fixture?.cleanup();
});

describe("K12a: a session title is display metadata, never identity", () => {
  test("registerSession stores {title} as canonical JSON; omitted or null stores null", () => {
    expect(value(run.op2)).toMatchObject({ outcome: "created", row: { name: "sess-a", h_metadata: JSON.stringify({ title: TITLE }), is_active: true } });
    expect(value(run.op4).row.h_metadata).toBeNull();
    expect(value(run.op5).row.h_metadata).toBeNull();
  });

  test("a replay under the same id+name is already_satisfied and keeps the ORIGINAL title", () => {
    expect(value(run.op3)).toMatchObject({ outcome: "already_satisfied", row: { h_metadata: JSON.stringify({ title: TITLE }) } });
  });
});

describe("K9: closeSession is a one-way close recorded in internal_metadata (D7)", () => {
  test("the named peer must exist and be a CURRENT member; the session must exist in this workspace", () => {
    refused(run.op8, "invalid_reference", "/peer_name");
    refused(run.op9, "invalid_reference", "/peer_name");
    refused(run.op10, "invalid_reference", "/session_name");
    refused(run.op20, "invalid_reference", "/session_name");
    refused(run.op21, "invalid_reference", "/workspace_name");
  });

  test("a close flips is_active to false and records {at, by_peer, operation_id, reason}; the title survives", () => {
    const closed = value(run.op11);
    expect(closed.outcome).toBe("closed");
    expect(closed.row).toMatchObject({ name: "sess-a", is_active: false, h_metadata: JSON.stringify({ title: TITLE }) });
    expect(closed.row.internal_metadata).toBe(record("peer-a", "close-1"));
    expect(value(run.op15)).toEqual(closed.row);
  });

  test("an exact replay is idempotent and returns the original row, from a fresh owner too, with no write", () => {
    const closed = value(run.op11).row;
    expect(value(run.op12)).toEqual({ outcome: "idempotent", row: closed });
    expect(value(replay.op0)).toEqual({ outcome: "idempotent", row: closed });
    expect(replay.trace).toEqual([]);
  });

  test("the same operation_id with another payload is operation_digest; any other close of a closed session is already_closed", () => {
    const closed = value(run.op11).row;
    expect(value(run.op13)).toEqual({ outcome: "conflict", reason: "operation_digest", row: closed });
    expect(value(run.op14)).toEqual({ outcome: "conflict", reason: "already_closed", row: closed });
  });

  test("closed means closed: appends and joins are refused, and registration never reactivates", () => {
    const stopped = value(run.op16);
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.results).toEqual([]);
    expect(stopped.stop.error).toMatchObject({ code: "invalid_reference", path: "/session_name" });
    refused(run.op17, "invalid_reference", "/session_name");
    expect(value(run.op18)).toMatchObject({ outcome: "already_satisfied", row: { is_active: false } });
    expect(run.persistedMessages).toEqual([contextId("m1")]);
  });

  test("with no peer (the operator path) the record says by_peer null", () => {
    const closed = value(run.op19);
    expect(closed.outcome).toBe("closed");
    expect(closed.row.internal_metadata).toBe(record(null, "close-b"));
  });

  test("a session already inactive with no record is already_closed, and nothing is written", () => {
    expect(value(legacy.op0)).toMatchObject({ outcome: "conflict", reason: "already_closed", row: { is_active: false, internal_metadata: null } });
    expect(legacy.trace).toEqual([]);
  });

  test("stored internal_metadata that is not an object, or an ACTIVE session carrying a close record, is integrity_failure", () => {
    refused(corrupt.op0, "integrity_failure", "");
    refused(corrupt.op1, "integrity_failure", "");
    // Nothing was rewritten.
    expect(value(corrupt.op3).internal_metadata).toBe("not json");
  });

  test("other keys another writer stored are kept beside the close record", () => {
    const closed = value(corrupt.op2);
    expect(closed.outcome).toBe("closed");
    expect(closed.row.internal_metadata).toBe(record("peer-a", "close-1", REASON, { imported_from: "v3" }));
  });

  test("the writer facade carries closeSession; the reader does not", () => {
    expect(run.contextMethods).toContain("closeSession");
  });
});
