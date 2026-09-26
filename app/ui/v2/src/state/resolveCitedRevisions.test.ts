/** Failing-first tests for the live lookups behind the evidence labels
 *  (#33 AC3, fix-round 2). `fetch` is stubbed with a tiny in-memory server
 *  that answers exactly the envelopes the real kernel returns (verified live
 *  in the fix-round proof: `getRevisionAssociations` answers `null` for a
 *  revision not on accepted ancestry, and `getRecallEligibility` answers
 *  `{eligible, witness_event_id}`) -- no network, no dataset.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssociationLinkRow, DependentOccurrence } from "../api/evidenceReview";
import type { Bank } from "../api/memory";
import { MAX_STATUS_LOOKUPS, resolveCitedRevisions } from "./resolveCitedRevisions";
import { resolveCitingNodes } from "./resolveCitingNodes";

const bank: Bank = { bank: "default", token: "t", workspace: "default" };

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** `answer(method, body)` returns `[status, json]`. */
function stubServer(answer: (method: string, body: Record<string, unknown>) => [number, unknown]) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    const [status, json] = answer(method, body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function nrLink(node_id: string, revision_id: string, target_key: string, position = "0"): AssociationLinkRow {
  return {
    workspace_name: "default",
    revision_id: "rev-citing",
    position,
    relation: "derived_from",
    target_kind: "node_revision",
    target: JSON.stringify({ node_id, revision_id }),
    target_key,
    excerpt: null,
    content_hash: null,
    captured_at: null,
    capture_status: "captured",
    note: null,
  };
}

function association(node_id: string, revision_id: string, head: string) {
  return {
    workspace_name: "default",
    node_id,
    revision_id,
    content_digest: "d",
    snapshot_head_revision_id: head,
    is_snapshot_head: revision_id === head,
    terms: [],
    links: [],
  };
}

describe("resolveCitedRevisions", () => {
  test("an old revision of a superseded node resolves as not-head and not eligible", async () => {
    stubServer((method, body) => {
      if (method === "getRevisionAssociations") return [200, association(String(body.node_id), String(body.revision_id), "rev2")];
      if (method === "getRecallEligibility") return [200, { eligible: false, witness_event_id: "ev1" }];
      return [404, { error: "error" }];
    });
    const map = await resolveCitedRevisions(bank, [nrLink("node1", "rev1", "k1")]);
    expect(map.get("k1")).toEqual({ kind: "resolved", isHead: false, headRevisionId: "rev2", eligible: false, eligibilityError: null });
    // The exact revision is asked for, never the head (null) -- the label is about what was CITED.
    expect(calls.find((c) => c.method === "getRevisionAssociations")!.body).toMatchObject({ node_id: "node1", revision_id: "rev1" });
  });

  test("a revision the server does not have on accepted history is not_found", async () => {
    stubServer((method) => (method === "getRevisionAssociations" ? [200, null] : [200, { eligible: true, witness_event_id: "x" }]));
    const map = await resolveCitedRevisions(bank, [nrLink("node1", "gone", "k1")]);
    expect(map.get("k1")).toEqual({ kind: "not_found" });
  });

  test("a refused lookup is lookup_failed with the governed code", async () => {
    stubServer(() => [403, { error: { code: "forbidden", message: "no" } }]);
    const map = await resolveCitedRevisions(bank, [nrLink("node1", "rev1", "k1")]);
    expect(map.get("k1")).toEqual({ kind: "lookup_failed", error: "forbidden" });
  });

  test("a failed recall read keeps the head verdict but marks eligibility unknown", async () => {
    stubServer((method, body) =>
      method === "getRevisionAssociations"
        ? [200, association(String(body.node_id), String(body.revision_id), "rev1")]
        : [500, { nope: true }],
    );
    const map = await resolveCitedRevisions(bank, [nrLink("node1", "rev1", "k1")]);
    expect(map.get("k1")).toEqual({ kind: "resolved", isHead: true, headRevisionId: "rev1", eligible: null, eligibilityError: "HTTP 500" });
  });

  test("non-node_revision links are never looked up, and a repeated target is looked up once", async () => {
    stubServer((method, body) =>
      method === "getRevisionAssociations"
        ? [200, association(String(body.node_id), String(body.revision_id), "rev1")]
        : [200, { eligible: true, witness_event_id: "x" }],
    );
    const url: AssociationLinkRow = { ...nrLink("n", "r", "k-url"), target_kind: "url", target: '{"url":"https://example.com"}' };
    const map = await resolveCitedRevisions(bank, [url, nrLink("node1", "rev1", "k1", "1"), nrLink("node1", "rev1", "k1", "2")]);
    expect(map.has("k-url")).toBe(false);
    expect(calls.filter((c) => c.method === "getRevisionAssociations").length).toBe(1);
    expect(map.get("k1")).toMatchObject({ kind: "resolved", isHead: true, eligible: true });
  });

  test("a malformed node_revision target is lookup_failed without a request", async () => {
    stubServer(() => [200, null]);
    const bad = { ...nrLink("n", "r", "k-bad"), target: "not json" };
    const map = await resolveCitedRevisions(bank, [bad]);
    expect(map.get("k-bad")).toMatchObject({ kind: "lookup_failed" });
    expect(calls.length).toBe(0);
  });

  test(`targets past the first ${MAX_STATUS_LOOKUPS} are labelled not_checked, not silently skipped`, async () => {
    stubServer((method, body) =>
      method === "getRevisionAssociations"
        ? [200, association(String(body.node_id), String(body.revision_id), String(body.revision_id))]
        : [200, { eligible: true, witness_event_id: "x" }],
    );
    const links = Array.from({ length: MAX_STATUS_LOOKUPS + 2 }, (_, i) => nrLink(`n${i}`, `r${i}`, `k${i}`, String(i)));
    const map = await resolveCitedRevisions(bank, links);
    expect(map.size).toBe(MAX_STATUS_LOOKUPS + 2);
    expect(map.get(`k${MAX_STATUS_LOOKUPS}`)).toMatchObject({ kind: "not_checked" });
    expect(map.get("k0")).toMatchObject({ kind: "resolved" });
  });
});

describe("resolveCitingNodes", () => {
  function occ(node_id: string): DependentOccurrence {
    return {
      workspace_name: "default",
      node_id,
      revision_id: `rev-${node_id}`,
      revision_no: "1",
      content_digest: "d",
      snapshot_head_revision_id: `rev-${node_id}`,
      is_snapshot_head: true,
      link: nrLink("node1", "rev1", "k1"),
    };
  }

  test("each citing node is looked up once, and its eligibility mapped", async () => {
    stubServer((_m, body) => [200, { eligible: body.node_id !== "retired", witness_event_id: "x" }]);
    const map = await resolveCitingNodes(bank, [occ("live"), occ("retired"), occ("live")]);
    expect(map.get("live")).toEqual({ kind: "resolved", eligible: true });
    expect(map.get("retired")).toEqual({ kind: "resolved", eligible: false });
    expect(calls.map((c) => c.method)).toEqual(["getRecallEligibility", "getRecallEligibility"]);
  });

  test("a failed or malformed read is lookup_failed, never assumed eligible", async () => {
    stubServer((_m, body) => (body.node_id === "denied" ? [403, { error: { code: "forbidden" } }] : [200, { eligible: "yes" }]));
    const map = await resolveCitingNodes(bank, [occ("denied"), occ("odd")]);
    expect(map.get("denied")).toEqual({ kind: "lookup_failed", error: "forbidden" });
    expect(map.get("odd")).toMatchObject({ kind: "lookup_failed" });
  });
});
