/** Failing-first (fix round, 2026-09-26): an independent verifier showed a
 *  `scanReason` set by a KEYWORD search survives into a SEMANTIC result --
 *  semantic responses never carry `scan_reason`, so the UI kept showing a
 *  stale "used a plain substring scan…" note on real semantic hits.
 *  `bun test src/state/applySearchOutcome.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { ApiResult } from "../api/client";
import { applySearchOutcome, type SearchOutcome } from "./applySearchOutcome";

const EMPTY: SearchOutcome = {
  errorCode: null,
  keywordHits: [],
  semanticHits: [],
  scanReason: null,
  embeddingProfile: null,
};

const keywordHit = {
  node_id: "n1",
  revision_id: "r1",
  title: "t",
  snippet: "s",
  chunk_ids: [],
  rank: 1,
  match: "ngram" as const,
};

const semanticHit = { node_id: "n2", revision_id: "r2", title: "t2", snippet: "s2", chunk_ids: [], distance: 0.1 };

const ok = (body: unknown): ApiResult => ({ ok: true, status: 200, durationMs: 1, body });
const failed = (): ApiResult => ({ ok: false, status: 503, durationMs: 1, body: { error: { code: "model_unavailable" } } });

describe("applySearchOutcome", () => {
  test("keyword success sets hits and the scan_reason note", () => {
    const out = applySearchOutcome("keyword", ok({ hits: [keywordHit], scan_reason: "short_query" }), EMPTY);
    expect(out.keywordHits).toEqual([keywordHit]);
    expect(out.scanReason).toBe("short_query");
  });

  test("semantic success clears a scanReason left over from an earlier keyword search", () => {
    const afterKeyword = applySearchOutcome("keyword", ok({ hits: [], scan_reason: "short_query" }), EMPTY);
    expect(afterKeyword.scanReason).toBe("short_query");

    const afterSemantic = applySearchOutcome(
      "semantic",
      ok({ hits: [semanticHit], embedding_profile: "e5" }),
      afterKeyword,
    );
    expect(afterSemantic.semanticHits).toEqual([semanticHit]);
    expect(afterSemantic.embeddingProfile).toBe("e5");
    // This is the bug: without the fix, scanReason keeps the "keyword" value
    // it inherited from `previous` instead of being cleared for a mode that
    // never produces one.
    expect(afterSemantic.scanReason).toBeNull();
  });

  test("an error resets both hit lists and the scan note, and records the code", () => {
    const seeded: SearchOutcome = { ...EMPTY, keywordHits: [keywordHit], scanReason: "index_unavailable" };
    const out = applySearchOutcome("keyword", failed(), seeded);
    expect(out.errorCode).toBe("model_unavailable");
    expect(out.keywordHits).toEqual([]);
    expect(out.scanReason).toBeNull();
  });
});
