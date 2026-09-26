/**
 * #30 / #10 keyword hit ORDER, the pure half -- overnight R22
 * (docs/overnight/DECISIONS.md): "Keyword hit ORDER uses workspace-local
 * signals only".
 *
 * BM25 over the ONE FTS index every workspace shares may pick candidates; it
 * may not order the answer. The order is computed from the workspace's own
 * rows, three keys, each a total tie-break for the one before:
 *
 *   1. occurrences of the query in the node's current head text, under R14's
 *      own matching rule (`containsFolded`: both sides `toLowerCase()`d),
 *      descending -- `countFolded`;
 *   2. the head revision's acceptance instant (`node_revisions.created_at`,
 *      exact microseconds), descending;
 *   3. `node_id`, ascending.
 *
 * Nothing here needs a dataset; `search-chunk-retrieval-order.test.ts` proves
 * the same order end to end, and `search-chunk-retrieval-score-isolation` /
 * `-overfetch-bound` prove what it buys across workspaces.
 */

import { describe, expect, test } from "bun:test";
import { containsFolded, countFolded } from "../src/fts/fts";
import { keywordHitOrder, type KeywordOrderKey } from "../src/publication/search-chunk";

describe("countFolded: occurrences under R14's matching rule", () => {
  test("counts case-folded occurrences of the whole query, left to right, never overlapping", () => {
    expect(countFolded("Kettle notes\n\nkettle and KETTLE.", "kettle")).toBe(3);
    expect(countFolded("Kettle notes\n\nkettle and KETTLE.", "KeTtLe")).toBe(3);
    // Non-overlapping, as String.prototype.split / Python's str.count: after
    // a match, the scan resumes AFTER it.
    expect(countFolded("aaaa", "aa")).toBe(2);
    expect(countFolded("aaa", "aa")).toBe(1);
    // Thai inside a word (the #10 case) counts like any substring.
    expect(countFolded("ฉันหลงลืมกุญแจ และหลงลืมอีก", "ลืม")).toBe(2);
    expect(countFolded("the quick brown fox", "zebra")).toBe(0);
    // The fold is the WHOLE-text toLowerCase() containsFolded uses, final
    // sigma included: "ΣΑΣ" folds to "σας", which holds one σ.
    expect(countFolded("ΣΑΣ", "σ")).toBe(1);
    // A query longer than the text, or an empty one, is never an occurrence.
    expect(countFolded("ab", "abc")).toBe(0);
    expect(countFolded("abc", "")).toBe(0);
  });

  test("an occurrence is counted exactly when containsFolded would admit the node", () => {
    const texts = ["Kettle notes\n\nkettle and KETTLE.", "ฉันหลงลืมกุญแจไว้ที่บ้าน", "ΣΑΣ σας", "aaaa", "", "İstanbul", "ǅemal"];
    const queries = ["kettle", "KETTLE", "ลืม", "หลงทาง", "σ", "ς", "aa", "a", "i̇", "ǆ", "x"];
    for (const text of texts) {
      for (const query of queries) {
        expect(countFolded(text, query) > 0, `${JSON.stringify(text)} / ${JSON.stringify(query)}`).toBe(containsFolded(text, query));
      }
    }
  });
});

describe("keywordHitOrder: occurrences, then the head's accepted_at, then node id", () => {
  const T = 1_758_412_800_000_000n;
  const key = (node_id: string, occurrences: number, accepted_at: bigint): KeywordOrderKey => ({ node_id, occurrences, accepted_at });

  test("more occurrences first, whatever the acceptance time or node id", () => {
    const many = key("zzz", 3, T);
    const newer = key("aaa", 1, T + 10_000_000n);
    expect(keywordHitOrder(many, newer)).toBeLessThan(0);
    expect(keywordHitOrder(newer, many)).toBeGreaterThan(0);
  });

  test("equal occurrences: the later-accepted head first, exact to the microsecond", () => {
    // 1 µs apart: the stored timestamp[us] is compared as the exact bigint.
    const later = key("zzz", 1, T + 1n);
    const earlier = key("aaa", 1, T);
    expect(keywordHitOrder(later, earlier)).toBeLessThan(0);
    expect(keywordHitOrder(earlier, later)).toBeGreaterThan(0);
  });

  test("equal occurrences and acceptance: node id ascending (code-unit order)", () => {
    expect(keywordHitOrder(key("A", 1, T), key("a", 1, T))).toBeLessThan(0);
    expect(keywordHitOrder(key("b", 1, T), key("a", 1, T))).toBeGreaterThan(0);
    expect(keywordHitOrder(key("a", 1, T), key("a", 1, T))).toBe(0);
  });

  test("a total order: every permutation of the same hits sorts to one sequence", () => {
    const expected = [key("n5", 4, T), key("n3", 2, T + 2n), key("n1", 2, T + 1n), key("n2", 2, T + 1n), key("n4", 1, T + 9n), key("n0", 1, T)];
    const permutations = (items: KeywordOrderKey[]): KeywordOrderKey[][] =>
      items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    for (const order of permutations([...expected].reverse())) {
      expect([...order].sort(keywordHitOrder).map((hit) => hit.node_id)).toEqual(expected.map((hit) => hit.node_id));
    }
  });
});
