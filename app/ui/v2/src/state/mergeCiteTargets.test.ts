/** The cite picker offers revisions the UI has already loaded this session. */
import { describe, expect, test } from "bun:test";
import { mergeCiteTargets } from "./mergeCiteTargets";

const t = (n: string) => ({ node_id: `node${n}`, revision_id: `rev${n}`, revision_no: "1", title: n });

describe("mergeCiteTargets", () => {
  test("newest first, deduplicated by revision id, capped", () => {
    expect(mergeCiteTargets([t("a"), t("b")], [t("c"), t("a")], 3).map((x) => x.title)).toEqual(["c", "a", "b"]);
    expect(mergeCiteTargets([t("a"), t("b")], [t("c")], 2).map((x) => x.title)).toEqual(["c", "a"]);
  });
});
