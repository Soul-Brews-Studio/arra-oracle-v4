/** Failing-first RENDER tests for the #33 evidence-review panels (fix-round 2).
 *
 * The pure label functions are tested on their own; these check that the
 * panels actually SHOW them. `react-dom/server`'s `renderToStaticMarkup` is
 * already installed with `react-dom` (no new dependency, no DOM needed), and
 * `createElement` keeps this a `.ts` file so `tsconfig.json`'s
 * `src/**\/*.test.ts` exclusion still applies.
 *
 * The fixture mirrors the verifier's live repro: one revision citing a `url`
 * (locator_only), a `code` path (unresolved) and a `node_revision` (captured)
 * whose revision is no longer its node's head and whose node was superseded.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssociationLinkRow, AssociationResult, DependentOccurrence } from "../api/evidenceReview";
import type { RevisionRow } from "../api/knowledge";
import type { CitedRevisionStatus, CitingNodeStatus } from "../state/evidenceStatus.types";
import { AssociationPanel } from "./AssociationPanel";
import { DependentsPanel } from "./DependentsPanel";
import { LifecyclePanel } from "./LifecyclePanel";
import { RevisionDiff } from "./RevisionDiff";

function link(overrides: Partial<AssociationLinkRow>): AssociationLinkRow {
  return {
    workspace_name: "default",
    revision_id: "rev3ccccccccccccccccc",
    position: "0",
    relation: "supports",
    target_kind: "url",
    target: '{"url":"https://example.com"}',
    target_key: "key-url",
    excerpt: null,
    content_hash: null,
    captured_at: null,
    capture_status: "locator_only",
    note: null,
    ...overrides,
  };
}

const association: AssociationResult = {
  workspace_name: "default",
  node_id: "node3ccccccccccccccccc",
  revision_id: "rev3ccccccccccccccccc",
  content_digest: "d",
  snapshot_head_revision_id: "rev3ccccccccccccccccc",
  is_snapshot_head: true,
  terms: [],
  links: [
    link({ position: "0" }),
    link({
      position: "1",
      relation: "derived_from",
      target_kind: "code",
      target: '{"commit":"abc","path":"app/server/src/x.ts","repo":"r"}',
      target_key: "key-code",
      capture_status: "unresolved",
    }),
    link({
      position: "2",
      relation: "related_to",
      target_kind: "node_revision",
      target: '{"node_id":"node1aaaaaaaaaaaaaaaa","revision_id":"rev1aaaaaaaaaaaaaaaaa"}',
      target_key: "key-nr",
      capture_status: "captured",
      captured_at: "2026-09-26T10:00:00.000000Z",
    }),
  ],
};

describe("AssociationPanel labels stale/unavailable direct evidence", () => {
  const cited: ReadonlyMap<string, CitedRevisionStatus> = new Map([
    [
      "key-nr",
      { kind: "resolved", isHead: false, headRevisionId: "rev2bbbbbbbbbbbbbbbbb", eligible: false, eligibilityError: null },
    ],
  ]);
  const html = renderToStaticMarkup(
    createElement(AssociationPanel, { row: association, loading: false, error: null, citedStatus: cited }),
  );

  test("each link shows its capture status", () => {
    expect(html).toContain("locator only");
    expect(html).toContain("unresolved");
    expect(html).toContain("captured");
  });

  test("a cited non-head revision of a superseded node is labelled stale and superseded", () => {
    expect(html).toContain("stale: not head");
    expect(html).toContain("target superseded/retired");
  });

  test("a node_revision link whose lookup has not landed reads as checking, not as resolved", () => {
    const pending = renderToStaticMarkup(
      createElement(AssociationPanel, { row: association, loading: false, error: null, citedStatus: new Map() }),
    );
    expect(pending).toContain("checking target…");
    expect(pending).not.toContain("current head");
  });
});

describe("DependentsPanel labels stale/unavailable reverse evidence", () => {
  const occurrence: DependentOccurrence = {
    workspace_name: "default",
    node_id: "node5eeeeeeeeeeeeeeeee",
    revision_id: "rev5eeeeeeeeeeeeeeeee",
    revision_no: "1",
    content_digest: "d",
    snapshot_head_revision_id: "rev5eeeeeeeeeeeeeeeee",
    is_snapshot_head: true,
    link: link({ target_kind: "node_revision", relation: "derived_from", capture_status: "unresolved" }),
  };
  const citing: ReadonlyMap<string, CitingNodeStatus> = new Map([
    ["node5eeeeeeeeeeeeeeeee", { kind: "resolved", eligible: false }],
  ]);
  const html = renderToStaticMarkup(
    createElement(DependentsPanel, {
      rows: [occurrence],
      loading: false,
      error: null,
      hasMore: false,
      onLoadMore: () => {},
      citingStatus: citing,
    }),
  );

  test("the citing link's capture status is shown", () => {
    expect(html).toContain("unresolved");
  });

  test("a citing node that was superseded or retired is labelled", () => {
    expect(html).toContain("citing node superseded/retired");
  });
});

describe("LifecyclePanel does not claim 'never superseded' when the history read failed", () => {
  test("an error replaces the empty state instead of sitting beside it", () => {
    const html = renderToStaticMarkup(
      createElement(LifecyclePanel, {
        nodeId: "node1aaaaaaaaaaaaaaaa",
        recall: null,
        recallError: null,
        history: [],
        loading: false,
        error: "invalid_value",
      }),
    );
    expect(html).toContain("invalid_value");
    expect(html).not.toContain("never superseded or retired");
  });
});

describe("RevisionDiff renders a relabelled term (taxonomy label snapshots)", () => {
  test("a renamed term shows both its old and new name", () => {
    const termBefore = {
      term_id: "t-topic",
      vocabulary_id: "voc-topic",
      vocabulary_name_snapshot: "topic",
      term_name_snapshot: "storage",
      label_snapshot: null,
      position: "0",
    };
    const row = (id: string, no: string, t: typeof termBefore): RevisionRow => ({
      id,
      node_id: "node1",
      revision_no: no,
      base_revision_id: null,
      operation_id: `op-${id}`,
      title: "t",
      body: "b",
      body_format: "markdown",
      fields: "{}",
      author_peer_name: null,
      observer_peer_name: null,
      subject_peer_name: null,
      session_name: null,
      is_active: true,
      valid_from: null,
      valid_to: null,
      change_reason: null,
      created_at: "2026-09-27T00:00:00.000Z",
      schema_version: "1",
      canonical_version: "arra-revision/v1",
      content_digest: `d-${id}`,
      term_snapshot_json: JSON.stringify([t]),
      link_snapshot_json: "[]",
    });
    const html = renderToStaticMarkup(
      createElement(RevisionDiff, {
        from: row("r1", "1", termBefore),
        to: row("r2", "2", { ...termBefore, term_name_snapshot: "storage_renamed" }),
      }),
    );
    expect(html).toContain("topic:storage");
    expect(html).toContain("topic:storage_renamed");
    expect(html).not.toContain("no term changes");
  });
});
