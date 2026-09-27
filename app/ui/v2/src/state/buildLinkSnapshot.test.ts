/** Failing-first tests for #33 AC1 "cite": the link editor's drafts become
 *  `link_snapshot_json` entries in EXACTLY the shape `contracts/revision-v1.ts`
 *  `normalizeLinks` accepts (LINK_KEYS, closed per-kind `target` from
 *  `contracts/evidence-v1.ts` TARGET_KEYS), and anything the server would
 *  refuse is caught here first with a message naming the link and field. */
import { describe, expect, test } from "bun:test";
import { buildLinkSnapshot } from "./buildLinkSnapshot";
import type { LinkDraft } from "./linkDraft.types";

const NODE = "nodeAAAAAAAAAAAAAAAAA";
const REV = "revAAAAAAAAAAAAAAAAAA";
const MSG = "msgAAAAAAAAAAAAAAAAAA";

const draft = (overrides: Partial<LinkDraft>): LinkDraft => ({
  relation: "supports",
  target_kind: "node_revision",
  fields: { node_id: NODE, revision_id: REV },
  note: "",
  ...overrides,
});

describe("buildLinkSnapshot", () => {
  test("no drafts is the empty snapshot the server already accepts", () => {
    expect(buildLinkSnapshot([])).toEqual({ ok: true, entries: [] });
  });

  test("a node_revision citation has the closed LINK_KEYS shape, locator_only, contiguous positions", () => {
    const built = buildLinkSnapshot([
      draft({}),
      draft({ relation: "discusses", target_kind: "url", fields: { url: "https://example.com/a?b=1" }, note: "why" }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.entries.map((e) => Object.keys(e))).toEqual([
      ["position", "relation", "target_kind", "target", "excerpt", "content_hash", "captured_at", "capture_status", "note"],
      ["position", "relation", "target_kind", "target", "excerpt", "content_hash", "captured_at", "capture_status", "note"],
    ]);
    expect(built.entries[0]).toEqual({
      position: "0",
      relation: "supports",
      target_kind: "node_revision",
      target: { node_id: NODE, revision_id: REV },
      excerpt: null,
      content_hash: null,
      captured_at: null,
      // Nothing was fetched or hashed: claiming `captured` would be a lie
      // the server does not check (revision-evidence-v1.md line 122).
      capture_status: "locator_only",
      note: null,
    });
    expect(built.entries[1]!.position).toBe("1");
    expect(built.entries[1]!.target).toEqual({ url: "https://example.com/a?b=1" });
    expect(built.entries[1]!.note).toBe("why");
  });

  test("the target carries exactly TARGET_KEYS for its kind, never stray fields from another kind", () => {
    const built = buildLinkSnapshot([
      draft({ target_kind: "message", fields: { session_name: "s-1", message_public_id: MSG, node_id: NODE } }),
      draft({ target_kind: "session", fields: { session_name: "s-1", url: "https://x.y" } }),
      draft({ target_kind: "trace", fields: { trace_id: "t-1" } }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.entries.map((e) => e.target)).toEqual([
      { session_name: "s-1", message_public_id: MSG },
      { session_name: "s-1" },
      { trace_id: "t-1" },
    ]);
  });

  test("startPosition lets a caller reserve earlier positions (the correction's own corrects link)", () => {
    const built = buildLinkSnapshot([draft({})], 1);
    expect(built.ok && built.entries[0]!.position).toBe("1");
  });

  test("ids the server would refuse are refused here, naming the link and the field", () => {
    const built = buildLinkSnapshot([draft({}), draft({ fields: { node_id: NODE, revision_id: "short" } })]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors).toHaveLength(1);
    expect(built.errors[0]).toContain("link 2");
    expect(built.errors[0]).toContain("revision_id");
  });

  test("a message needs both a session name and a nanoid21 public id", () => {
    const built = buildLinkSnapshot([draft({ target_kind: "message", fields: { session_name: "", message_public_id: "x" } })]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.join(" ")).toContain("session_name");
    expect(built.errors.join(" ")).toContain("message_public_id");
  });

  test("urls follow the server's passive check: http(s) only, no credentials, no whitespace", () => {
    for (const url of ["javascript:alert(1)", "https://u:p@example.com", " https://example.com", "not a url", ""]) {
      const built = buildLinkSnapshot([draft({ target_kind: "url", fields: { url } })]);
      expect(built.ok).toBe(false);
    }
  });

  test("a relation or kind outside the contract is refused rather than sent", () => {
    const bad = buildLinkSnapshot([
      draft({ relation: "endorses" as LinkDraft["relation"] }),
      draft({ target_kind: "code" as LinkDraft["target_kind"] }),
    ]);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors).toHaveLength(2);
  });
});
