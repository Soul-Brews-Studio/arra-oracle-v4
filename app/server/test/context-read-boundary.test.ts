/**
 * #87 / R3 (docs/overnight/DECISIONS.md): membership is a real read boundary
 * on `listMessages` and `getMessage`, at the SERVICE level.
 *
 * The real kernel over a fresh mkdtemp two-workspace dataset, driven inside the
 * real writer gate (`read-boundary-fixture.ts` for the layout). The second
 * argument each read takes is the transport-built `RequestAuthority`:
 *   - `operator`: the admitted principal also holds `audit:read` on the
 *     workspace, so it may read without naming a requester (the operator view);
 *   - `peers`: the grant's arra-auth/v1 `peers` binding, or null when unbound.
 *
 * Rules pinned here:
 *   - no requester and no operator view -> `forbidden` (HTTP 403), before any
 *     storage read;
 *   - a named requester must hold CURRENT membership of the session -- the same
 *     `requireCurrentMembership` check getContext applies. listMessages refuses
 *     with `invalid_reference` at /requester_peer_name, like getContext;
 *     getMessage answers null, exactly as for an absent id, so a non-member
 *     cannot learn that a message id exists (authorization-v1.md §3);
 *   - a binding that does not list the requester -> `forbidden`, before
 *     membership is consulted; no binding -> behaviour unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseGetMessage, parseListMessages } from "../src/publication/context";
import { encodeRequest, type ContextFixture } from "./helpers/context-fixture";
import {
  ALPHA,
  BETA,
  MAIN_ID,
  OPERATOR,
  READER,
  SECRET_ID,
  bound,
  createReadBoundaryFixture,
  driveContext,
  op,
} from "./helpers/read-boundary-fixture";

const TEST_TIMEOUT_MS = 300_000;

const list = (workspace: string, session: string, requester?: string | null) => ({
  workspace_name: workspace,
  session_name: session,
  after_seq: null,
  limit: 10,
  ...(requester === undefined ? {} : { requester_peer_name: requester }),
});
const get = (workspace: string, publicId: string, requester?: string | null) => ({
  workspace_name: workspace,
  public_id: publicId,
  ...(requester === undefined ? {} : { requester_peer_name: requester }),
});

const contents = (result: any): string[] => {
  expect(result?.ok, JSON.stringify(result)).toBe(true);
  return (result.value.rows as Array<{ content: string }>).map((row) => row.content);
};
const refused = (result: any, code: string, path: string) => {
  expect(result?.ok, `expected a ${code} refusal, got ${JSON.stringify(result)}`).toBe(false);
  expect({ code: result.code, path: result.path, version: result.version }).toEqual({
    code,
    path,
    version: "arra-publication-error/v1",
  });
};

let fixture: ContextFixture;
beforeAll(async () => {
  fixture = await createReadBoundaryFixture();
}, TEST_TIMEOUT_MS);
afterAll(async () => {
  await fixture?.cleanup();
});

describe("grammar: requester_peer_name is the one optional key", () => {
  test("absent and null both mean 'no requester'; a present value is a scoped name", () => {
    expect(parseListMessages(encodeRequest(list(ALPHA, "s"))).requester_peer_name).toBeNull();
    expect(parseListMessages(encodeRequest(list(ALPHA, "s", null))).requester_peer_name).toBeNull();
    expect(parseListMessages(encodeRequest(list(ALPHA, "s", "peer-a"))).requester_peer_name).toBe("peer-a");
    expect(parseGetMessage(encodeRequest(get(ALPHA, SECRET_ID))).requester_peer_name).toBeNull();
    expect(parseGetMessage(encodeRequest(get(ALPHA, SECRET_ID, null))).requester_peer_name).toBeNull();
    expect(parseGetMessage(encodeRequest(get(ALPHA, SECRET_ID, "peer-b"))).requester_peer_name).toBe("peer-b");
  });

  test("a bad requester value is a governed grammar error at its own pointer", () => {
    const codeAt = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        const e = error as { code?: string; path?: string };
        return `${e.code} ${e.path}`;
      }
      return "NO_THROW";
    };
    for (const parse of [parseListMessages, parseGetMessage] as const) {
      const base = parse === parseListMessages ? list(ALPHA, "s") : get(ALPHA, SECRET_ID);
      expect(codeAt(() => parse(encodeRequest({ ...base, requester_peer_name: "" })))).toBe("invalid_value /requester_peer_name");
      expect(codeAt(() => parse(encodeRequest({ ...base, requester_peer_name: 7 })))).toBe("invalid_type /requester_peer_name");
      expect(codeAt(() => parse(encodeRequest({ ...base, requester_peer_name: "x".repeat(257) })))).toBe(
        "limit_exceeded /requester_peer_name",
      );
      // The grammar stays closed: `peer_name` is not an alias for the requester.
      expect(codeAt(() => parse(encodeRequest({ ...base, peer_name: "peer-a" })))).toBe("unexpected_field /peer_name");
    }
  });
});

describe("service: listMessages and getMessage enforce the read boundary", () => {
  test(
    "no requester: a content:read-only caller is forbidden, the operator view reads",
    async () => {
      const r = await driveContext(fixture.datasetRoot, [
        op("listMessages", list(ALPHA, "sess-secret"), READER),
        op("getMessage", get(ALPHA, SECRET_ID), READER),
        op("listMessages", list(ALPHA, "sess-secret", null), READER),
        op("getMessage", get(ALPHA, SECRET_ID, null), READER),
        op("listMessages", list(ALPHA, "sess-secret"), OPERATOR),
        op("getMessage", get(ALPHA, SECRET_ID), OPERATOR),
        // Refused BEFORE storage: even a session that does not exist is
        // forbidden rather than a reference error, so the refusal says nothing
        // about what the workspace contains.
        op("listMessages", list(ALPHA, "no-such-session"), READER),
      ]);
      refused(r.op0, "forbidden", "/requester_peer_name");
      refused(r.op1, "forbidden", "/requester_peer_name");
      refused(r.op2, "forbidden", "/requester_peer_name");
      refused(r.op3, "forbidden", "/requester_peer_name");
      expect(contents(r.op4)).toEqual(["SECRET-alpha"]);
      expect(r.op5.value?.content).toBe("SECRET-alpha");
      refused(r.op6, "forbidden", "/requester_peer_name");
      expect(JSON.stringify(r)).not.toContain("SECRET-beta");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a non-member requester is denied: list refuses, get answers null exactly as for an absent id",
    async () => {
      const r = await driveContext(fixture.datasetRoot, [
        op("listMessages", list(ALPHA, "sess-secret", "peer-a"), READER),
        op("getMessage", get(ALPHA, SECRET_ID, "peer-a"), READER),
        op("getMessage", get(ALPHA, "absentabsentabsentabs", "peer-a"), READER),
        // A peer that does not exist is a member of nothing.
        op("listMessages", list(ALPHA, "sess-secret", "nobody"), READER),
        op("getMessage", get(ALPHA, SECRET_ID, "nobody"), READER),
        // The operator view does not widen a NAMED requester's view.
        op("listMessages", list(ALPHA, "sess-secret", "peer-a"), OPERATOR),
        op("getMessage", get(ALPHA, SECRET_ID, "peer-a"), OPERATOR),
      ]);
      refused(r.op0, "invalid_reference", "/requester_peer_name");
      expect(r.op1).toEqual({ ok: true, value: null });
      expect(r.op2).toEqual({ ok: true, value: null });
      refused(r.op3, "invalid_reference", "/requester_peer_name");
      expect(r.op4).toEqual({ ok: true, value: null });
      refused(r.op5, "invalid_reference", "/requester_peer_name");
      expect(r.op6).toEqual({ ok: true, value: null });
      expect(JSON.stringify(r)).not.toContain("SECRET-");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a departed member is denied; its history stays readable in the operator view",
    async () => {
      const r = await driveContext(fixture.datasetRoot, [
        op("listMessages", list(ALPHA, "sess-secret", "peer-c"), READER),
        op("getMessage", get(ALPHA, SECRET_ID, "peer-c"), READER),
        op("listMessages", list(ALPHA, "sess-secret"), OPERATOR),
      ]);
      refused(r.op0, "invalid_reference", "/requester_peer_name");
      expect(r.op1).toEqual({ ok: true, value: null });
      expect(contents(r.op2)).toEqual(["SECRET-alpha"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a current member reads its session, and only its session",
    async () => {
      const r = await driveContext(fixture.datasetRoot, [
        op("listMessages", list(ALPHA, "sess-secret", "peer-b"), READER),
        op("getMessage", get(ALPHA, SECRET_ID, "peer-b"), READER),
        op("listMessages", list(ALPHA, "sess-main", "peer-a"), READER),
        op("getMessage", get(ALPHA, MAIN_ID, "peer-a"), READER),
        // peer-b is a member of sess-secret, not sess-main.
        op("listMessages", list(ALPHA, "sess-main", "peer-b"), READER),
        op("getMessage", get(ALPHA, MAIN_ID, "peer-b"), READER),
      ]);
      expect(contents(r.op0)).toEqual(["SECRET-alpha"]);
      expect(r.op1.value?.content).toBe("SECRET-alpha");
      expect(r.op1.value?.session_name).toBe("sess-secret");
      expect(contents(r.op2)).toEqual(["main-alpha"]);
      expect(r.op3.value?.content).toBe("main-alpha");
      refused(r.op4, "invalid_reference", "/requester_peer_name");
      expect(r.op5).toEqual({ ok: true, value: null });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "colliding session names and public_ids never cross workspaces, for members or operators",
    async () => {
      const r = await driveContext(fixture.datasetRoot, [
        // peer-a IS a current member of sess-secret in beta, and of nothing
        // secret in alpha: beta's membership must not open alpha's session.
        op("listMessages", list(ALPHA, "sess-secret", "peer-a"), READER),
        op("getMessage", get(ALPHA, SECRET_ID, "peer-a"), READER),
        op("listMessages", list(BETA, "sess-secret", "peer-a"), READER),
        op("getMessage", get(BETA, SECRET_ID, "peer-a"), READER),
        op("getMessage", get(ALPHA, SECRET_ID), OPERATOR),
        op("getMessage", get(BETA, SECRET_ID), OPERATOR),
        op("listMessages", list(BETA, "sess-main", "peer-b"), READER),
      ]);
      refused(r.op0, "invalid_reference", "/requester_peer_name");
      expect(r.op1).toEqual({ ok: true, value: null });
      expect(contents(r.op2)).toEqual(["SECRET-beta"]);
      expect(r.op3.value?.content).toBe("SECRET-beta");
      expect(r.op4.value?.content).toBe("SECRET-alpha");
      expect(r.op5.value?.content).toBe("SECRET-beta");
      expect(contents(r.op6)).toEqual(["main-beta"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a peers binding refuses any other requester before membership; no binding changes nothing",
    async () => {
      const r = await driveContext(fixture.datasetRoot, [
        // peer-b is a real current member, but the binding names only peer-a.
        op("listMessages", list(ALPHA, "sess-secret", "peer-b"), bound(["peer-a"])),
        op("getMessage", get(ALPHA, SECRET_ID, "peer-b"), bound(["peer-a"])),
        // A binding holds even for an operator that names a requester.
        op("listMessages", list(ALPHA, "sess-secret", "peer-b"), bound(["peer-a"], true)),
        // An empty binding lets the principal assert no peer at all.
        op("listMessages", list(ALPHA, "sess-main", "peer-a"), bound([])),
        // The bound peer itself reads its own session.
        op("listMessages", list(ALPHA, "sess-main", "peer-a"), bound(["peer-a"])),
        op("getMessage", get(ALPHA, MAIN_ID, "peer-a"), bound(["peer-a"])),
        // Unbound: the same requests behave exactly as they did before R3.
        op("listMessages", list(ALPHA, "sess-secret", "peer-b"), READER),
        // A binding never grants the operator view.
        op("listMessages", list(ALPHA, "sess-main"), bound(["peer-a"])),
      ]);
      refused(r.op0, "forbidden", "/requester_peer_name");
      refused(r.op1, "forbidden", "/requester_peer_name");
      refused(r.op2, "forbidden", "/requester_peer_name");
      refused(r.op3, "forbidden", "/requester_peer_name");
      expect(contents(r.op4)).toEqual(["main-alpha"]);
      expect(r.op5.value?.content).toBe("main-alpha");
      expect(contents(r.op6)).toEqual(["SECRET-alpha"]);
      refused(r.op7, "forbidden", "/requester_peer_name");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a message read with no transport-built authority fails closed and returns nothing",
    async () => {
      const r = await driveContext(fixture.datasetRoot, [
        op("listMessages", list(ALPHA, "sess-secret", "peer-b")),
        op("getMessage", get(ALPHA, SECRET_ID, "peer-b")),
        op("listMessages", list(ALPHA, "sess-secret"), { operator: "yes", peers: null }),
        op("getMessage", get(ALPHA, SECRET_ID), { operator: true, peers: "peer-b" }),
      ]);
      for (const key of ["op0", "op1", "op2", "op3"]) {
        expect(r[key].ok, JSON.stringify(r[key])).toBe(false);
        expect(r[key].name).toBe("TypeError");
      }
      expect(JSON.stringify(r)).not.toContain("SECRET-");
    },
    TEST_TIMEOUT_MS,
  );
});
