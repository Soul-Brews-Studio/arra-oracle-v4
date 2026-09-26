/** Wire-shape coverage for `api/search.ts` (fix-round, nonblocking finding):
 *  the previous slice shipped with no test on this file at all -- a verifier
 *  ran mutation testing and found a renamed method plus an `embedding_profile`
 *  field smuggled into the keyword request (the server would reject that as
 *  `unexpected_field`, R21) left every existing test green. This locks the
 *  two request shapes down at the transport boundary.
 *  `bun test src/api/search.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Bank } from "./memory";
import { searchKnowledgeKeyword, searchKnowledgeSemantic } from "./search";

const bank: Bank = { bank: "b1", workspace: "w1", token: "" };
const originalFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

describe("api/search wire shapes", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("searchKnowledgeKeyword calls the keyword method with exactly {workspace_name, query, limit}", async () => {
    const calls = stubFetch(200, { match: "ngram", scan_reason: null, hits: [] });
    await searchKnowledgeKeyword(bank, "ลืม");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/knowledge/b1/searchKnowledgeKeyword");
    const sentBody = JSON.parse(calls[0]!.init.body as string);
    expect(sentBody).toEqual({ workspace_name: "w1", query: "ลืม", limit: 20 });
  });

  test("searchKnowledgeSemantic calls the semantic method, a distinct endpoint from keyword", async () => {
    const calls = stubFetch(200, { embedding_profile: "e5-large", metric: "l2_squared", hits: [] });
    await searchKnowledgeSemantic(bank, "ลืม");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/knowledge/b1/searchKnowledgeSemantic");
    const sentBody = JSON.parse(calls[0]!.init.body as string);
    expect(sentBody).toEqual({ workspace_name: "w1", query: "ลืม", limit: 20 });
  });
});
