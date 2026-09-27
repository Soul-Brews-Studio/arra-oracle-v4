/** Failing-first (ui-prov fix round, 2026-09-27). The independent verifier
 *  REFUTED the first cut: with every chunk `ready`, the panel said "keyword
 *  and semantic search can both find this revision" for a RETIRED head and
 *  for an `is_active: false` head -- and the server's real searches returned
 *  `{"hits":[]}` for both. Search drops any node that is not recall-eligible
 *  (`service.currentEligibleChunks.ts` step 3 -> `evaluateNodeEligibility`:
 *  retired, superseded, inactive, not yet valid, expired), and
 *  `getAcceptedHead` keeps those heads readable, so the panel shows for them.
 *
 * So the view now keeps two facts apart: the CHUNK state (what
 * `listSearchChunks` says about this revision's rows and vectors) and whether
 * search RETURNS the node (`getRecallEligibility`, the same rule search
 * applies). A findability claim is only ever made for an eligible node; an
 * unreadable eligibility is `unknown`, never "searchable".
 *
 * Also pinned here (verifier's nonblocking findings): a mixed failed+pending
 * chunk set, the embed attempt cap, and the "no expected chunk count" caveat.
 */
import { describe, expect, test } from "bun:test";
import { type EligibilityRead, type FreshnessRead, searchFreshnessView } from "./searchFreshnessView";

const PROFILE = "minilm-l6-v2/384";
const FRESHNESS = {
  content: { nodes: 2, revisions: 2 },
  text_index: { indexed_rows: null, unindexed_rows: null },
  vectors: {
    profile_id: PROFILE,
    pending: 0,
    ready: 1,
    failed: 0,
    last_attempt_at: null,
    model_digest: { pinned: null, last_measured: null },
  },
};

const chunk = (status: string, attempts = "0", error_code: string | null = null) => ({
  status,
  attempts,
  error_code,
  last_attempt_at: null,
});
const eligible: EligibilityRead = { ok: true, body: { eligible: true, witness_event_id: "0", reasons: [] } };
const ineligible = (...reasons: string[]): EligibilityRead => ({
  ok: true,
  body: { eligible: false, witness_event_id: "1", reasons },
});
const read = (chunks: unknown[], eligibility: EligibilityRead): FreshnessRead => ({
  phase: "ok",
  freshness: FRESHNESS,
  chunks,
  eligibility,
});

/** Every positive findability phrase the view has ever used. */
const FINDABLE = /can both|can return|find this revision|reads chunk text|reads the chunk text/;

describe("search findability follows recall eligibility, not chunk status", () => {
  const cases: [string, string, RegExp][] = [
    ["retired", "retired", /retired/],
    ["superseded", "superseded", /superseded/],
    ["inactive", "inactive", /inactive/],
    ["not_yet_valid", "not_yet_valid", /not valid yet/],
    ["expired", "expired", /valid_to/],
  ];
  for (const [name, reason, words] of cases) {
    test(`${name} head with every chunk ready: chunks read "indexed", search says it is excluded`, () => {
      const v = searchFreshnessView(read([chunk("ready")], ineligible(reason)));
      expect(v.state).toBe("indexed");
      expect(v.search?.state).toBe("excluded");
      expect(v.search?.text).toMatch(words);
      expect(v.search?.text).toContain("does not return this node");
      expect(v.meaning).not.toMatch(FINDABLE);
      expect(v.search?.text).not.toMatch(FINDABLE);
    });
  }

  test("an ineligible PENDING head makes no keyword claim either", () => {
    const v = searchFreshnessView(read([chunk("pending")], ineligible("inactive")));
    expect(v.state).toBe("pending");
    expect(v.search?.state).toBe("excluded");
    expect(`${v.meaning} ${v.search?.text}`).not.toMatch(FINDABLE);
  });

  test("ineligible with no reason given still says excluded, and says the reason is missing", () => {
    const v = searchFreshnessView(read([chunk("ready")], ineligible()));
    expect(v.search?.state).toBe("excluded");
    expect(v.search?.text).toContain("gave no reason");
  });

  test("an eligibility read that failed is unknown -- never a findability claim", () => {
    const v = searchFreshnessView(read([chunk("ready")], { ok: false, message: "HTTP 503" }));
    expect(v.state).toBe("indexed");
    expect(v.search?.state).toBe("unknown");
    expect(v.search?.text).toContain("HTTP 503");
    expect(v.search?.text).not.toMatch(FINDABLE);
  });

  test("an eligibility body in an unknown shape is unknown too", () => {
    for (const body of [null, {}, { eligible: "yes" }, { eligible: false, reasons: "retired" }]) {
      const v = searchFreshnessView(read([chunk("ready")], { ok: true, body }));
      expect(v.search?.state).toBe("unknown");
      expect(v.search?.text).not.toMatch(FINDABLE);
    }
  });

  test("an ELIGIBLE indexed head is the only case that says both searches can return it", () => {
    const v = searchFreshnessView(read([chunk("ready"), chunk("ready")], eligible));
    expect(v.search?.state).toBe("searchable");
    expect(v.search?.text).toContain("keyword and semantic search can both return");
  });

  test("an eligible pending head: keyword yes, semantic skips the chunks without a vector", () => {
    const v = searchFreshnessView(read([chunk("pending"), chunk("ready")], eligible));
    expect(v.search?.state).toBe("searchable");
    expect(v.search?.text).toContain("semantic search skips 1 chunk");
  });

  test("an eligible unindexed head: neither search can return it yet", () => {
    const v = searchFreshnessView(read([], eligible));
    expect(v.state).toBe("unindexed");
    expect(v.search?.state).toBe("not_searchable");
    expect(v.search?.text).toContain("neither keyword nor semantic search");
  });

  test("loading and unknown freshness carry no search line at all", () => {
    expect(searchFreshnessView({ phase: "loading" }).search).toBeNull();
    expect(searchFreshnessView({ phase: "error", stage: "freshness", message: "x" }).search).toBeNull();
  });
});

describe("chunk-state honesty the first cut left unpinned", () => {
  test("mixed failed + pending: failed wins, and the pending chunks are still counted and said", () => {
    const v = searchFreshnessView(read([chunk("failed", "1", "embedder_unavailable"), chunk("pending"), chunk("ready")], eligible));
    expect(v.state).toBe("failed");
    expect(v.chunks).toEqual({ total: 3, pending: 1, ready: 1, failed: 1 });
    expect(v.meaning).toContain("1 of 3 chunks failed to embed");
    expect(v.meaning).toContain("1 more still waits for the embed worker");
  });

  test("failed under the attempt cap: embedPendingChunks will retry it", () => {
    const v = searchFreshnessView(read([chunk("failed", "2", "embedder_unavailable")], eligible));
    expect(v.meaning).toContain("will retry");
    expect(v.meaning).not.toContain("will not retry");
  });

  test("failed AT the attempt cap (5): no retry is coming, and the view says so", () => {
    const v = searchFreshnessView(read([chunk("failed", "5", "embedder_bad_response")], eligible));
    expect(v.meaning).toContain("reached the 5-attempt cap");
    expect(v.meaning).toContain("will not retry");
    expect(v.meaning).not.toContain("until a retry succeeds");
  });

  test("failed with an unreadable attempt count says the retry outlook is unknown", () => {
    const v = searchFreshnessView(read([chunk("failed", "n/a")], eligible));
    expect(v.meaning).toContain("attempt count could not be read");
  });

  test("indexed discloses that a missing chunk row would not show", () => {
    const v = searchFreshnessView(read([chunk("ready")], eligible));
    expect(v.meaning).toContain("no expected chunk count");
  });
});
