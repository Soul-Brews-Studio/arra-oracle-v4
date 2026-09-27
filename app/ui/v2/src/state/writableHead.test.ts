/** Found live in the ui-cite browser proof: after a revise, clicking "new"
 *  could leave the PREVIOUS node's head on screen (a late `refresh` landing
 *  after the selection moved), so a draft offered Correct and would publish
 *  with the other node's head as its base. Writes only trust a head that
 *  belongs to the node being written. */
import { describe, expect, test } from "bun:test";
import type { RevisionRow } from "../api/knowledge";
import { writableHead } from "./writableHead";

const row = (id: string, node_id: string) => ({ id, node_id, revision_no: "1", title: id }) as RevisionRow;

describe("writableHead", () => {
  test("the selected node's own head and history pass through", () => {
    expect(writableHead("A", row("a2", "A"), [row("a2", "A"), row("a1", "A")])).toEqual({
      head: row("a2", "A"),
      revisions: [row("a2", "A"), row("a1", "A")],
    });
  });

  test("a draft (nothing selected) never inherits another node's head", () => {
    expect(writableHead(null, row("a2", "A"), [row("a2", "A")])).toEqual({ head: null, revisions: [] });
  });

  test("a late head for a different node is dropped", () => {
    expect(writableHead("B", row("a2", "A"), [row("a2", "A")])).toEqual({ head: null, revisions: [] });
  });
});
