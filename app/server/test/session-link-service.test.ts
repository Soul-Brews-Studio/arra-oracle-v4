/**
 * Session links v1 -- minimal smoke test.
 *
 * Not exhaustive by design: this proves the wired path actually works --
 * create, read back both directions, replay, self-link refusal -- and leaves
 * ownership/recovery/precision coverage to their own dispatched lanes.
 */

import { describe, expect, test } from "bun:test";
import { runGated } from "./helpers/publication-fixture";
import { peerRequest, sessionRequest } from "./helpers/context-fixture";
import {
  createSessionLinkFixture,
  createSessionLinkRequest,
  listSessionLinksRequest,
  sessionLinkId,
} from "./helpers/session-link-fixture";

describe("preflight: the required surface", () => {
  test("the pure module exists and exports its grammar", async () => {
    const mod = await import("../src/publication/session-link").catch((error) => ({
      __absent: String(error),
    }));
    expect(mod).not.toHaveProperty("__absent");
    expect(typeof (mod as Record<string, unknown>).parseCreateSessionLink).toBe("function");
    expect(typeof (mod as Record<string, unknown>).parseListSessionLinks).toBe("function");
    expect(typeof (mod as Record<string, unknown>).encodeSessionLinkRow).toBe("function");
    expect((mod as Record<string, unknown>).SESSION_RELATIONS).toEqual([
      "continues", "forked_from", "related_to",
    ]);
  });
});

describe("real persistence: session links inside the real gate", () => {
  const CHILD = new URL("./fixtures/session-link-v1/core/gated-session-link.ts", import.meta.url).pathname;
  const ALPHA = "alpha-workspace";
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  const drive = async (
    root: string,
    ops: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    return JSON.parse(line);
  };
  const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });

  /** Peer and two sessions, through the REAL API. */
  const seedOps = () => [
    ctx("registerPeer", peerRequest(ALPHA)),
    ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessA"), name: "sess-a" })),
    ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessB"), name: "sess-b" })),
  ];
  const SEED = 3;

  test("create, read back both directions, replay, and self-link refusal", async () => {
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA)),
        ctx("getSessionLinks", listSessionLinksRequest(ALPHA, { session_name: "sess-a", direction: "from" })),
        ctx("getSessionLinks", listSessionLinksRequest(ALPHA, { session_name: "sess-b", direction: "to" })),
        // Exact replay: identical payload under the same id.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA)),
        // Changed payload under the same id: a RETURNED conflict.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, { relation: "related_to" })),
        // Self-link, for a directed relation: invalid_request at /to_session_name.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("link2"), from_session_name: "sess-a", to_session_name: "sess-a",
        })),
      ]);

      const created = parsed[`op${SEED}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");
      expect(Object.keys(created.value.row)).toEqual([
        "id", "workspace_name", "from_session_name", "to_session_name",
        "relation", "evidence_ref", "created_by_peer_name", "created_at",
      ]);
      expect(created.value.row.from_session_name).toBe("sess-a");
      expect(created.value.row.to_session_name).toBe("sess-b");
      expect(created.value.row.relation).toBe("continues");
      expect(created.value.row.created_at).toBe("2026-09-21T00:00:00.000Z");

      const fromRead = parsed[`op${SEED + 1}`];
      expect(fromRead.ok, JSON.stringify(fromRead)).toBe(true);
      expect(fromRead.value.rows).toHaveLength(1);
      expect(fromRead.value.rows[0]).toEqual(created.value.row);
      expect(fromRead.value.next_cursor).toBeNull();

      const toRead = parsed[`op${SEED + 2}`];
      expect(toRead.ok, JSON.stringify(toRead)).toBe(true);
      expect(toRead.value.rows).toHaveLength(1);
      expect(toRead.value.rows[0]).toEqual(created.value.row);

      const replay = parsed[`op${SEED + 3}`];
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      expect(replay.value.outcome).toBe("already_satisfied");
      expect(replay.value.row).toEqual(created.value.row);

      const conflict = parsed[`op${SEED + 4}`];
      expect(conflict.ok, JSON.stringify(conflict)).toBe(true);
      expect(conflict.value.outcome).toBe("conflict");
      expect(conflict.value.row).toEqual(created.value.row);

      const selfLink = parsed[`op${SEED + 5}`];
      expect(selfLink.ok).toBe(false);
      expect(selfLink).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_request",
        path: "/to_session_name",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});
