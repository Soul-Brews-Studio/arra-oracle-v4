/** Failing-first WIRING test for #33 AC1 "cite": `publishRevision` used to
 *  hardcode `link_snapshot_json: "[]"`, so no UI path could ever write a link.
 *  This stubs `fetch` (no server, no DOM) and reads the envelope actually
 *  sent. */
import { afterEach, describe, expect, test } from "bun:test";
import { type LinkSnapshotEntry, mintTaxonomyIds, publishRevision } from "./knowledge";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("publishRevision wiring", () => {
  test("sends the caller's links as link_snapshot_json TEXT, not a hardcoded []", async () => {
    let sent: { content?: Record<string, unknown> } = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ outcome: "accepted" }), { status: 200 });
    }) as unknown as typeof fetch;

    const links: LinkSnapshotEntry[] = [
      {
        position: "0",
        relation: "corrects",
        target_kind: "node_revision",
        target: { node_id: "nodeAAAAAAAAAAAAAAAAA", revision_id: "revAAAAAAAAAAAAAAAAAA" },
        excerpt: null,
        content_hash: null,
        captured_at: null,
        capture_status: "locator_only",
        note: null,
      },
    ];
    await publishRevision({ bank: "b", workspace: "w", token: "" } as never, mintTaxonomyIds(), {
      node_id: "corrNNNNNNNNNNNNNNNNN",
      base_revision_id: null,
      title: "t",
      body: "b",
      body_format: "text",
      type_term: "correction",
      horizon: null,
      author_peer_name: null,
      session_name: null,
      change_reason: null,
      links,
    });
    expect(typeof sent.content?.link_snapshot_json).toBe("string");
    expect(JSON.parse(sent.content!.link_snapshot_json as string)).toEqual(links);
  });
});
