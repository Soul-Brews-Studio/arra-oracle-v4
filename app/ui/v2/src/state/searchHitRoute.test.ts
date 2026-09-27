/** Failing-first (fix round, 2026-09-26): a verifier found that clicking a
 *  search hit only selected a row in Explore's own paged "nodes" tab
 *  (`{ tab: "nodes" }`) -- a tab that never renders title/body/history, and
 *  can show nothing at all if the hit is past the first page. The brief
 *  asks for the EXISTING node view, i.e. `KnowledgeView` at
 *  `#/knowledge?node=…`. `bun test src/state/searchHitRoute.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { searchHitRoute } from "./searchHitRoute";

describe("searchHitRoute", () => {
  test("routes to the knowledge view with the hit's node id", () => {
    const patch = searchHitRoute("gO0ER2i24z0XVa4OiFthi");
    expect(patch.view).toBe("knowledge");
    expect(patch.node).toBe("gO0ER2i24z0XVa4OiFthi");
  });

  test("does not carry Explore's tab field -- the refuted behaviour switched tabs instead of views", () => {
    const patch = searchHitRoute("n1");
    expect(patch.tab).toBeUndefined();
    expect(patch.peer).toBeUndefined();
    expect(patch.session).toBeUndefined();
  });
});
