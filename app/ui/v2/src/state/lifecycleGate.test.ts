/** Failing-first tests for #33 lifecycle awareness: the Knowledge view reads
 *  the same `listLifecycleHistory` the Evidence tab reads, and a superseded
 *  or retired node blocks publish and correct with an explanation, naming
 *  the successor when the event carries one. */
import { describe, expect, test } from "bun:test";
import type { LifecycleEventRow } from "../api/evidenceReview";
import { lifecycleGate } from "./lifecycleGate";

const NODE = "nodeAAAAAAAAAAAAAAAAA";

const event = (overrides: Partial<LifecycleEventRow>): LifecycleEventRow => ({
  id: "1",
  workspace_name: "default",
  old_id: NODE,
  old_revision_id: "revAAAAAAAAAAAAAAAAAA",
  old_title: "old",
  old_type: "note",
  new_id: null,
  new_revision_id: null,
  new_title: null,
  reason: "obsolete",
  peer_name: null,
  superseded_at: "2026-09-27T00:00:00.000Z",
  operation_id: "opAAAAAAAAAAAAAAAAAAA",
  h_metadata: null,
  ...overrides,
});

describe("lifecycleGate", () => {
  test("a draft (no node yet) and a node with no events are active and not blocked", () => {
    expect(lifecycleGate({ nodeId: null, loading: false, error: null, rows: [] })).toMatchObject({
      state: "active",
      blocked: false,
      label: null,
    });
    expect(lifecycleGate({ nodeId: NODE, loading: false, error: null, rows: [] })).toMatchObject({
      state: "active",
      blocked: false,
    });
  });

  test("a supersede event blocks writes and names the successor", () => {
    const gate = lifecycleGate({
      nodeId: NODE,
      loading: false,
      error: null,
      rows: [event({ new_id: "nodeBBBBBBBBBBBBBBBBB", new_revision_id: "revBBBBBBBBBBBBBBBBBB", new_title: "v2" })],
    });
    expect(gate.state).toBe("superseded");
    expect(gate.blocked).toBe(true);
    expect(gate.label).toBe("superseded");
    expect(gate.successor).toEqual({ node_id: "nodeBBBBBBBBBBBBBBBBB", revision_id: "revBBBBBBBBBBBBBBBBBB", title: "v2" });
    expect(gate.explanation).toContain("v2");
    expect(gate.explanation).toContain("obsolete");
  });

  test("a retire event blocks writes and has no successor", () => {
    const gate = lifecycleGate({ nodeId: NODE, loading: false, error: null, rows: [event({ reason: "wrong" })] });
    expect(gate.state).toBe("retired");
    expect(gate.blocked).toBe(true);
    expect(gate.successor).toBeNull();
    expect(gate.explanation).toContain("wrong");
  });

  test("while the read is in flight writes wait, so a click cannot race a terminal node", () => {
    expect(lifecycleGate({ nodeId: NODE, loading: true, error: null, rows: [] })).toMatchObject({
      state: "loading",
      blocked: true,
    });
  });

  test("a failed read is labelled unknown, not claimed active, and does not block", () => {
    const gate = lifecycleGate({ nodeId: NODE, loading: false, error: "forbidden", rows: [] });
    expect(gate.state).toBe("unknown");
    expect(gate.blocked).toBe(false);
    expect(gate.label).toBe("lifecycle unknown");
    expect(gate.explanation).toContain("forbidden");
  });

  test("events for a different node never gate this one", () => {
    const gate = lifecycleGate({ nodeId: NODE, loading: false, error: null, rows: [event({ old_id: "otherXXXXXXXXXXXXXXXX" })] });
    expect(gate.state).toBe("active");
  });
});
