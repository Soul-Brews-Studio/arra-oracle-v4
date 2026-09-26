/**
 * #85 -- `coverage` means COMPLETE (overnight ruling R4,
 * docs/overnight/DECISIONS.md; amendment in app/docs/contracts/chat-v1.md).
 *
 * Proven here, against a real gated dataset and then over the real HTTP and
 * MCP transports on that same dataset:
 *
 *   1. `coverage` is `"full"` only when NOTHING was excluded, for any reason.
 *      An unauthorized exclusion, a `max_items` stop, a wire-budget stop and
 *      the linked-session bound each make it `"partial"`.
 *   2. Unauthorized items are never identified: one aggregate
 *      `{reason:"unauthorized", count}` entry replaces them, and no secret
 *      public_id, session name or content appears anywhere in the result --
 *      including an unauthorized candidate that sorts past the item cap,
 *      which used to be relabelled `budget_exceeded` WITH its identifiers.
 *   3. Budget and limit exclusions keep their identifiers.
 *   4. `excluded` has its own truncation signal (`excluded_omitted`) when it
 *      hits its byte bound, instead of borrowing `coverage`.
 *   5. `answerChat` never hands unauthorized evidence to the model (a
 *      recording stub), and its response carries the same coverage.
 *
 * Slow on purpose: ~320 messages are appended inside the gate in one child,
 * the fewest that still overflow the excluded list's byte bound.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createOperationService } from "../src/auth/service";
import { createKnowledgeAccess } from "../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";
import { MAX_CONTEXT_WIRE_BYTES } from "../src/publication/chat";
import { createContextFixture } from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";

const CHILD = new URL("./fixtures/chat-v1/gated-coverage.ts", import.meta.url).pathname;
const TIMEOUT_MS = 300_000;
const WS = "alpha-workspace";
const ORIGIN = "http://127.0.0.1:3939";
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN, "ascii").digest("hex");

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

type Excluded = { reason: string; session_name?: string | null; public_id?: string | null; count?: number };
type Result = {
  items: { public_id: string; content: string }[];
  coverage: "full" | "partial";
  excluded: Excluded[];
  excluded_omitted: number;
};
type Attempt = { ok: boolean; value: Result & { answer?: string; items_used?: string[] }; code?: string; message?: string };

let cleanup: (() => Promise<void>) | null = null;
let policyDir: string | null = null;
let seeded: Record<string, unknown> = {};
let app: { handle: (request: Request) => Promise<Response> };

const scenario = (name: string): Result => {
  const run = seeded[name] as Attempt | undefined;
  if (run === undefined) throw new Error(`no scenario ${name}: ${JSON.stringify(seeded.error ?? null)}`);
  if (!run.ok) throw new Error(`${name} failed: ${run.code} ${run.message}`);
  return run.value;
};

/** No secret identifier, session name or content, anywhere in the JSON. */
const expectNoSecret = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text.includes("SECRET")).toBe(false);
  expect(text.includes("secret-session")).toBe(false);
};

/** The invariant R4 states: full <=> nothing excluded and nothing omitted. */
const expectCoverageInvariant = (result: Result) => {
  const nothingExcluded = result.excluded.length === 0 && result.excluded_omitted === 0;
  expect(result.coverage).toBe(nothingExcluded ? "full" : "partial");
};

beforeAll(async () => {
  const fixture = await createContextFixture([WS]);
  cleanup = fixture.cleanup;
  const run = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot], { deadlineMs: TIMEOUT_MS - 30_000 });
  const line = run.stdout.trim().split("\n").pop();
  if (run.code !== 0 || line === undefined) {
    throw new Error(`gated child failed (${run.code}): ${run.stderr.slice(-1500)}`);
  }
  seeded = JSON.parse(line);

  // The transports read the SAME dataset through the production reader.
  policyDir = await mkdtemp(join(tmpdir(), "arra-v4-chat-coverage-"));
  const policyPath = join(policyDir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        { id: "reader", disabled: false, workspaces: [{ name: WS, actions: ["content:read"] }], global_actions: [] },
      ],
      credentials: [
        {
          id: "cred-reader",
          principal_id: "reader",
          sha256: TOKEN_SHA256,
          not_before: "2026-01-01T00:00:00.000Z",
          expires_at: "2030-01-01T00:00:00.000Z",
          revoked: false,
        },
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  const access = createKnowledgeAccess({ datasetRoot: fixture.datasetRoot, env: {} });
  configureKnowledgeAccess(access);
  // Only the audit append is reached on the kb_* path; the legacy memory
  // store is never touched by this file.
  const service = createOperationService({ policyPath }, { logCall: async () => {} } as never);
  app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
}, TIMEOUT_MS);

afterAll(async () => {
  configureKnowledgeAccess(null);
  if (policyDir !== null) await rm(policyDir, { recursive: true, force: true });
  if (cleanup !== null) await cleanup();
});

describe("getContext coverage is full only when nothing was excluded (R4)", () => {
  test("the child ran every scenario", () => {
    expect(seeded.error ?? null).toBeNull();
  });

  test("ample budget + one unauthorized linked message => partial, one aggregate entry, no secret ids", () => {
    const result = scenario("unauth");
    expect(result.items.map((i) => i.public_id)).toEqual([pad("unauthok1")]);
    expect(result.coverage).toBe("partial");
    expect(result.excluded).toEqual([{ reason: "unauthorized", count: 1 }]);
    expect(result.excluded_omitted).toBe(0);
    expectNoSecret(result);
    expectCoverageInvariant(result);
  });

  test("everything authorized and within bounds => full, nothing excluded", () => {
    const result = scenario("full");
    expect(result.items.map((i) => i.public_id).sort()).toEqual([pad("fullok1"), pad("fullok2")].sort());
    expect(result.coverage).toBe("full");
    expect(result.excluded).toEqual([]);
    expect(result.excluded_omitted).toBe(0);
  });

  test("max_items truncation => partial, and the budget entry keeps its identifiers", () => {
    const result = scenario("count");
    expect(result.items.map((i) => i.public_id)).toEqual([pad("countnew"), pad("countmid")]);
    expect(result.coverage).toBe("partial");
    expect(result.excluded).toEqual([
      { reason: "budget_exceeded", session_name: "count-main", public_id: pad("countold") },
    ]);
    expectCoverageInvariant(result);
  });

  test("wire-budget truncation => partial, identifiers kept", () => {
    const result = scenario("wire");
    expect(result.items.map((i) => i.public_id)).toEqual([pad("wirenew"), pad("wiremid")]);
    expect(result.coverage).toBe("partial");
    expect(result.excluded).toEqual([
      { reason: "budget_exceeded", session_name: "wire-main", public_id: pad("wireold") },
    ]);
    expectCoverageInvariant(result);
  });

  test("an unauthorized candidate past the item cap is counted as unauthorized, never relabelled with its ids", () => {
    const result = scenario("afterCap");
    expect(result.items.map((i) => i.public_id).sort()).toEqual([pad("aftercapok1"), pad("aftercapok2")].sort());
    expect(result.coverage).toBe("partial");
    expect(result.excluded).toEqual([{ reason: "unauthorized", count: 1 }]);
    expectNoSecret(result);
  });

  test("a ninth linked session is a reported limit truncation, not a silent drop", () => {
    const result = scenario("links");
    const ids = result.items.map((i) => i.public_id);
    expect(ids.length).toBe(9);
    expect(ids).not.toContain(pad("linksmsg8"));
    expect(result.coverage).toBe("partial");
    // Session-level entry: the unsearched set is open-ended, so it names no
    // session (it could name one the requester is not a member of).
    expect(result.excluded).toEqual([{ reason: "budget_exceeded", session_name: null, public_id: null }]);
    expect(JSON.stringify(result).includes("links-linked-8")).toBe(false);
    expectCoverageInvariant(result);
  });

  test("many unauthorized candidates across sessions fold into ONE anonymous entry", () => {
    const result = scenario("manyUnauth");
    expect(result.items.map((i) => i.public_id)).toEqual([pad("manyok1")]);
    expect(result.coverage).toBe("partial");
    // 8 sessions x (max_items + 1) per-session lookahead, at max_items 5.
    expect(result.excluded).toEqual([{ reason: "unauthorized", count: 8 * 6 }]);
    expect(result.excluded_omitted).toBe(0);
    expectNoSecret(result);
  });

  test("the excluded list is byte-bounded and signals its own truncation", () => {
    const result = scenario("overflow");
    expect(result.items.length).toBe(50);
    expect(result.coverage).toBe("partial");
    expect(utf8(result.excluded)).toBeLessThanOrEqual(MAX_CONTEXT_WIRE_BYTES);
    for (const entry of result.excluded) {
      expect(entry.reason).toBe("budget_exceeded");
      expect(typeof entry.session_name).toBe("string");
      expect(typeof entry.public_id).toBe("string");
    }
    expect(result.excluded_omitted).toBeGreaterThan(0);
    // 5 sessions x 51 candidates, 50 included: every other one is either
    // listed or counted as omitted -- none vanishes.
    expect(result.excluded.length + result.excluded_omitted).toBe(5 * 51 - 50);
  });
});

describe("answerChat carries the corrected coverage and never feeds unauthorized evidence to the model", () => {
  test("the recording stub saw only authorized evidence; the response is partial with the aggregate", () => {
    const answer = seeded.unauthAnswer as Attempt;
    expect(answer.ok).toBe(true);
    expect(answer.value.answer).toBe("stub answer");
    expect(answer.value.coverage).toBe("partial");
    expect(answer.value.excluded).toEqual([{ reason: "unauthorized", count: 1 }]);
    expect(answer.value.excluded_omitted).toBe(0);
    expect(answer.value.items_used).toEqual([pad("unauthok1")]);
    expectNoSecret(answer.value);

    const inputs = seeded.unauthModelInputs as { items: { public_id: string }[]; context_text: string }[];
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.items.map((i) => i.public_id)).toEqual([pad("unauthok1")]);
    expect(inputs[0]!.context_text.includes("authorized visible message")).toBe(true);
    expectNoSecret(inputs);
  });

  test("all authorized => answerChat reports full", () => {
    const answer = seeded.fullAnswer as Attempt;
    expect(answer.ok).toBe(true);
    expect(answer.value.coverage).toBe("full");
    expect(answer.value.excluded).toEqual([]);
    expect(answer.value.excluded_omitted).toBe(0);
  });
});

describe("the same results over the live transports (production reader, real policy)", () => {
  const request = (session_name: string, max_items: number) => ({
    workspace_name: WS,
    peer_name: "peer-a",
    session_name,
    max_items,
  });

  const viaHttp = async (payload: Record<string, unknown>): Promise<Result> => {
    const res = await app.handle(
      new Request(`${ORIGIN}/api/knowledge/${WS}/getContext`, {
        method: "POST",
        headers: { host: "127.0.0.1:3939", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  };

  const viaMcp = async (payload: Record<string, unknown>): Promise<Result> => {
    const res = await app.handle(
      new Request(`${ORIGIN}/mcp/${WS}`, {
        method: "POST",
        headers: { host: "127.0.0.1:3939", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "kb_getContext", arguments: { payload } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError ?? false).toBe(false);
    return JSON.parse(body.result.content[0]!.text);
  };

  for (const [label, via] of [["HTTP", viaHttp], ["MCP", viaMcp]] as const) {
    test(`${label}: unauthorized omission is partial with an anonymous aggregate`, async () => {
      const result = await via(request("unauth-main", 10));
      expect(result.coverage).toBe("partial");
      expect(result.excluded).toEqual([{ reason: "unauthorized", count: 1 }]);
      expect(result.excluded_omitted).toBe(0);
      expect(result.items.map((i) => i.public_id)).toEqual([pad("unauthok1")]);
      expectNoSecret(result);
    });

    test(`${label}: all authorized is full`, async () => {
      const result = await via(request("full-main", 10));
      expect(result.coverage).toBe("full");
      expect(result.excluded).toEqual([]);
      expect(result.excluded_omitted).toBe(0);
    });

    test(`${label}: count truncation is partial with identifiers`, async () => {
      const result = await via(request("count-main", 2));
      expect(result.coverage).toBe("partial");
      expect(result.excluded).toEqual([
        { reason: "budget_exceeded", session_name: "count-main", public_id: pad("countold") },
      ]);
    });
  }
});
