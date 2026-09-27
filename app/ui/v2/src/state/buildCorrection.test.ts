/** Failing-first tests for #33 AC1 "correct": a correction is its own NODE of
 *  the sealed `type` term `correction` (R6: the type vocabulary is sealed, so
 *  the term must already be one of TYPE_TERMS; R10: `conclusion` is a
 *  different reserved term, never used for this), linked to the exact
 *  revision it corrects by a `corrects` -> `node_revision` link at position 0.
 *  The corrected revision is never edited. */
import { describe, expect, test } from "bun:test";
import { TYPE_TERMS } from "../api/knowledge";
import { buildCorrection } from "./buildCorrection";

const NEW = "corrNNNNNNNNNNNNNNNNN";
const NODE = "nodeAAAAAAAAAAAAAAAAA";
const REV = "revAAAAAAAAAAAAAAAAAA";

const base = {
  newNodeId: NEW,
  corrected: { node_id: NODE, revision_id: REV },
  title: "the port is 47778, not 47777",
  body: "rev 2 said 47777",
  body_format: "text" as const,
  change_reason: "",
  extraLinks: [],
};

describe("buildCorrection", () => {
  test("publishes a NEW node, type correction, first revision, with a corrects link pinned to the corrected revision", () => {
    const built = buildCorrection(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.node_id).toBe(NEW);
    expect(built.input.base_revision_id).toBeNull();
    expect(built.input.type_term).toBe("correction");
    expect(TYPE_TERMS).toContain(built.input.type_term);
    expect(built.input.type_term).not.toBe("conclusion");
    expect(built.input.change_reason).toBeNull();
    expect(built.input.links[0]).toEqual({
      position: "0",
      relation: "corrects",
      target_kind: "node_revision",
      target: { node_id: NODE, revision_id: REV },
      excerpt: null,
      content_hash: null,
      captured_at: null,
      capture_status: "locator_only",
      note: null,
    });
    expect(built.input.links).toHaveLength(1);
  });

  test("extra evidence links follow the corrects link at contiguous positions", () => {
    const built = buildCorrection({
      ...base,
      extraLinks: [{ relation: "supports", target_kind: "url", fields: { url: "https://example.com" }, note: "" }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.links.map((l) => [l.position, l.relation, l.target_kind])).toEqual([
      ["0", "corrects", "node_revision"],
      ["1", "supports", "url"],
    ]);
  });

  test("a draft has nothing to correct: no accepted revision means no correction", () => {
    const built = buildCorrection({ ...base, corrected: null });
    expect(built.ok).toBe(false);
  });

  test("a correction is a different node from the one it corrects", () => {
    const built = buildCorrection({ ...base, newNodeId: NODE });
    expect(built.ok).toBe(false);
  });

  test("title and body are required, and a bad extra link is reported, not dropped", () => {
    const built = buildCorrection({
      ...base,
      title: "",
      extraLinks: [{ relation: "supports", target_kind: "url", fields: { url: "ftp://x" }, note: "" }],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.some((e) => e.includes("title"))).toBe(true);
    expect(built.errors.some((e) => e.includes("link 2"))).toBe(true);
  });
});
