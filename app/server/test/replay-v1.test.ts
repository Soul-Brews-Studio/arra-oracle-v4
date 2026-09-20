import { expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import { parseStrict, type JcsValue } from "../src/contracts/jcs";
import { revisionReplayOp, sourceReplayOp } from "../src/contracts/replay-v1";
import { sourceReplayOutcome } from "../src/contracts/v1";

const D1 = "a".repeat(64), D2 = "b".repeat(64);
const MSG = "Msg00000000000000001_", REV = "Revn0000000000000001_";
const j = (t: string): JcsValue => parseStrict(t);
function expectError(fn: () => unknown, code: string, path: string) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect([(error as ContractError).code, (error as ContractError).path]).toEqual([code, path]);
    return;
  }
  throw new Error(`expected ${code} at ${JSON.stringify(path)}`);
}

const srcIn = (ns = "relic://claude/session/transcript", id = "275", d = D1, w = "w") =>
  j(`{"workspace_name":${JSON.stringify(w)},"source_namespace":${JSON.stringify(ns)},"source_message_id":${JSON.stringify(id)},"content_digest":"${d}"}`);
const srcEx = (ns = "relic://claude/session/transcript", id = "275", d = D1, w = "w") =>
  j(`{"workspace_name":${JSON.stringify(w)},"source_namespace":${JSON.stringify(ns)},"source_message_id":${JSON.stringify(id)},"content_digest":"${d}","message_public_id":"${MSG}"}`);
const revIn = (op = "op-1", d = D1, w = "w") => j(`{"workspace_name":${JSON.stringify(w)},"operation_id":${JSON.stringify(op)},"content_digest":"${d}"}`);
const revEx = (op = "op-1", d = D1, w = "w") => j(`{"workspace_name":${JSON.stringify(w)},"operation_id":${JSON.stringify(op)},"content_digest":"${d}","revision_id":"${REV}"}`);

test("source replay: new / idempotent (with original id) / conflict, and original_id is null unless idempotent", () => {
  expect(sourceReplayOp(srcIn(), null)).toEqual({ outcome: "new", original_id: null });
  expect(sourceReplayOp(srcIn(), srcEx())).toEqual({ outcome: "idempotent", original_id: MSG });
  expect(sourceReplayOp(srcIn(undefined, undefined, D2), srcEx())).toEqual({ outcome: "conflict", original_id: null });
});

test("source replay: an existing record outside the incoming scope is scope_mismatch, even with an equal digest", () => {
  expectError(() => sourceReplayOp(srcIn(), srcEx(undefined, undefined, D1, "other")), "scope_mismatch", "/existing/workspace_name");
  expectError(() => sourceReplayOp(srcIn(), srcEx("relic/บัญชี-primary")), "scope_mismatch", "/existing/source_namespace");
  expectError(() => sourceReplayOp(srcIn(), srcEx(undefined, "276")), "scope_mismatch", "/existing/source_message_id");
});

test("source_namespace is opaque exact bytes: no trim, casefold or URI equivalence", () => {
  expectError(() => sourceReplayOp(srcIn("relic://claude/session/transcript"), srcEx("relic://claude/session/transcript/")), "scope_mismatch", "/existing/source_namespace");
  expectError(() => sourceReplayOp(srcIn("relic://claude/session/transcript"), srcEx("RELIC://claude/session/transcript")), "scope_mismatch", "/existing/source_namespace");
  expectError(() => sourceReplayOp(srcIn("relic/บัญชี-primary"), srcEx("relic/บัญชี-primary ")), "scope_mismatch", "/existing/source_namespace");
  // Both existing spellings in the corpus are accepted as-is.
  expect(sourceReplayOp(srcIn("relic/บัญชี-primary"), srcEx("relic/บัญชี-primary")).outcome).toBe("idempotent");
});

test("source replay: shapes are closed and digests must be exactly 64 lowercase hex strings; validation precedes classification", () => {
  expectError(() => sourceReplayOp(j(`{"workspace_name":"w","source_namespace":"n","source_message_id":"1"}`), null), "missing_field", "/incoming/content_digest");
  expectError(() => sourceReplayOp(j(`{"workspace_name":"w","source_namespace":"n","source_message_id":"1","content_digest":"${D1}","x":1}`), null), "unexpected_field", "/incoming/x");
  expectError(() => sourceReplayOp(srcIn(undefined, undefined, D1.toUpperCase()), null), "invalid_value", "/incoming/content_digest");
  expectError(() => sourceReplayOp(srcIn(), j(`{"workspace_name":"w","source_namespace":"relic://claude/session/transcript","source_message_id":"275","content_digest":"${D1}","message_public_id":"short"}`)), "invalid_value", "/existing/message_public_id");
  expectError(() => sourceReplayOp(srcIn(""), null), "invalid_value", "/incoming/source_namespace");
  expectError(() => sourceReplayOp(srcIn(undefined, undefined, undefined, ""), null), "invalid_value", "/incoming/workspace_name");
  // Existing with a bad digest errors BEFORE any outcome, even though incoming is fine.
  expectError(() => sourceReplayOp(srcIn(), srcEx(undefined, undefined, "zz")), "invalid_value", "/existing/content_digest");
});

test("revision replay: same behaviour over (workspace, operation_id)", () => {
  expect(revisionReplayOp(revIn(), null)).toEqual({ outcome: "new", original_id: null });
  expect(revisionReplayOp(revIn(), revEx())).toEqual({ outcome: "idempotent", original_id: REV });
  expect(revisionReplayOp(revIn(undefined, D2), revEx())).toEqual({ outcome: "conflict", original_id: null });
  expectError(() => revisionReplayOp(revIn(), revEx("op-2")), "scope_mismatch", "/existing/operation_id");
  expectError(() => revisionReplayOp(revIn(), revEx(undefined, D1, "other")), "scope_mismatch", "/existing/workspace_name");
  expectError(() => revisionReplayOp(revIn(), j(`{"workspace_name":"w","operation_id":"op-1","content_digest":"${D1}"}`)), "missing_field", "/existing/revision_id");
});

test("bounded repair: legacy sourceReplayOutcome refuses digest ARRAYS and objects that RegExp.test would have coerced", () => {
  const good = "c".repeat(64);
  // Before the repair, `/^[a-f0-9]{64}$/.test([good])` was true: ToString of a one-element array is its element.
  expect(/^[a-f0-9]{64}$/.test([good] as unknown as string)).toBe(true);
  expect(() => sourceReplayOutcome(null, [good] as unknown as string)).toThrow(/string/);
  expect(() => sourceReplayOutcome([good] as unknown as string, good)).toThrow(/string/);
  expect(() => sourceReplayOutcome(null, { toString: () => good } as unknown as string)).toThrow(/string/);
  // Its three outcomes and message-digest domain are unchanged.
  expect(sourceReplayOutcome(null, good)).toBe("new");
  expect(sourceReplayOutcome(good, good)).toBe("idempotent");
  expect(sourceReplayOutcome("d".repeat(64), good)).toBe("conflict");
});
