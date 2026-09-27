/** Failing-first tests for the head revision's roles and provenance (#33
 *  design revision 2: "render ... provenance ... and distinct
 *  author/observer/subject; missing summary ... remain visible rather than
 *  fabricated").
 *
 * The acceptor (TASK-8, on d949290) found NodeHead showing only
 * revision/created/active/digest: a lone head had no author, observer or
 * subject at all -- only RevisionDiff rendered those roles. Every value here
 * comes from a column the 26-field revision row actually carries
 * (`api/knowledge.ts` RevisionRow); nothing is inferred from the principal,
 * and the revision contract has no summary column, so "summary" is always
 * the explicit absent marker, never text lifted from the body.
 */
import { describe, expect, test } from "bun:test";
import type { RevisionRow } from "../api/knowledge";
import { revisionProvenance } from "./revisionProvenance";
import { revisionRoles } from "./revisionRoles";

function revision(overrides: Partial<RevisionRow> = {}): RevisionRow {
  return {
    id: "rev2aaaaaaaaaaaaaaaaa",
    node_id: "node1aaaaaaaaaaaaaaaa",
    revision_no: "2",
    base_revision_id: "rev1aaaaaaaaaaaaaaaaa",
    operation_id: "op2aaaaaaaaaaaaaaaaaa",
    title: "ลืมรหัสผ่าน: password reset",
    body: "First line of the body.\nSecond line.",
    body_format: "markdown",
    fields: "{}",
    author_peer_name: "nat",
    observer_peer_name: "neo",
    subject_peer_name: "boy",
    session_name: "s-27sep",
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: "fix the reset steps",
    created_at: "2026-09-27T01:02:03.456Z",
    schema_version: "1",
    canonical_version: "arra-revision/v1",
    content_digest: "ab".repeat(32),
    ...overrides,
  };
}

describe("revisionRoles: three distinct roles, never one 'by'", () => {
  test("author, observer and subject each keep their own label and peer", () => {
    const roles = revisionRoles(revision());
    expect(roles.map((r) => r.role)).toEqual(["author", "observer", "subject"]);
    expect(roles.map((r) => r.peer)).toEqual(["nat", "neo", "boy"]);
    expect(roles.map((r) => r.text)).toEqual(["nat", "neo", "boy"]);
    expect(roles.every((r) => r.recorded)).toBe(true);
  });

  test("an absent role is said out loud, per role, and not borrowed from another", () => {
    const roles = revisionRoles(revision({ observer_peer_name: null }));
    const observer = roles.find((r) => r.role === "observer")!;
    expect(observer.recorded).toBe(false);
    expect(observer.peer).toBeNull();
    expect(observer.text).toBe("no observer recorded");
    // The author did not quietly become the observer.
    expect(roles.find((r) => r.role === "author")!.text).toBe("nat");
  });

  test("all three absent: three separate markers", () => {
    const roles = revisionRoles(
      revision({ author_peer_name: null, observer_peer_name: null, subject_peer_name: null }),
    );
    expect(roles.map((r) => r.text)).toEqual([
      "no author recorded",
      "no observer recorded",
      "no subject recorded",
    ]);
  });
});

describe("revisionProvenance: where the revision came from, as recorded", () => {
  const byKey = (r: RevisionRow) => Object.fromEntries(revisionProvenance(r).map((row) => [row.key, row]));

  test("every recorded provenance column is shown verbatim", () => {
    const rows = byKey(revision());
    expect(rows.revision!.value).toBe("#2 · rev2aaaaaaaaaaaaaaaaa");
    expect(rows.base!.value).toBe("rev1aaaaaaaaaaaaaaaaa");
    expect(rows.session!.value).toBe("s-27sep");
    expect(rows.operation!.value).toBe("op2aaaaaaaaaaaaaaaaaa");
    expect(rows.created!.value).toBe("2026-09-27T01:02:03.456Z");
    expect(rows.reason!.value).toBe("fix the reset steps");
    expect(rows.digest!.value).toBe("ab".repeat(32));
    expect(rows.envelope!.value).toBe("arra-revision/v1 · schema 1");
  });

  test("a first revision says it has no base; an absent session and reason are marked", () => {
    const rows = byKey(revision({ base_revision_id: null, session_name: null, change_reason: null }));
    expect(rows.base!.value).toBe("none — first revision of this node");
    expect(rows.session!.recorded).toBe(false);
    expect(rows.session!.value).toBe("no session recorded");
    expect(rows.reason!.recorded).toBe(false);
    expect(rows.reason!.value).toBe("no change reason recorded");
  });

  test("the validity window is shown only as recorded", () => {
    expect(byKey(revision()).validity!.value).toBe("no validity window recorded");
    expect(byKey(revision({ valid_from: "2026-09-01T00:00:00.000Z" })).validity!.value).toBe(
      "from 2026-09-01T00:00:00.000Z, open-ended",
    );
    expect(
      byKey(revision({ valid_from: "2026-09-01T00:00:00.000Z", valid_to: "2026-10-01T00:00:00.000Z" }))
        .validity!.value,
    ).toBe("from 2026-09-01T00:00:00.000Z to 2026-10-01T00:00:00.000Z");
  });

  test("missing summary is an explicit marker, never text taken from the body", () => {
    const summary = byKey(revision()).summary!;
    expect(summary.recorded).toBe(false);
    expect(summary.value).toBe("no summary");
    expect(summary.value).not.toContain("First line");
    expect(summary.value).not.toContain("password reset");
  });
});
