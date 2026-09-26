/**
 * R18 D3 fix round (overnight, v3-list slice): `listNodes`'s opt-in
 * `eligible_only` view -- the RECALL view the v3 adapter's recall tools
 * (`oracle_reflect`, `oracle_recap`, `oracle_inbox`) list through.
 *
 * Why this exists: an independent verifier showed those three tools returning
 * nodes `getRecallEligibility` itself calls ineligible (a head with
 * `is_active: false`, a closed validity window), because they listed through
 * `listNodes`'s DEFAULT view, which by #29's own ruling drops only nodes with
 * a terminal `supersede_log` row. `V3-PARITY.md` A6 (adopted by
 * `DECISIONS.md` R18 D3) requires recall paths to show only recall-eligible
 * nodes under the FULL #29 rule. This file pins the kernel half: the rule is
 * `evaluateNodeEligibility`'s own (shared, not restated), the `as_of` is the
 * caller-supplied request time (the kernel takes no clock), and the default
 * view is unchanged.
 *
 * Fresh `mktemp -d` dataset via `createFixture`; writes run inside the real
 * writer gate (`gated-lifecycle.ts`, the child the #29 tests already use);
 * reads go in-process through `openContextReader` with a FIXED `as_of`, the
 * same seam `knowledge/registry.ts` fills with `Date.now()` in production.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createFixture,
  encodeRequest,
  revisionEnvelope,
  runGated,
  type Fixture,
} from "./helpers/publication-fixture";
import { openContextReader } from "../src/publication/service";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/lifecycle-v1/core/gated-lifecycle.ts", import.meta.url).pathname;
const WS = "alpha-workspace";
/** The writer's sampled clock AND the default read `as_of`: nothing here reads a real clock. */
const AS_OF = Date.parse("2026-09-21T00:00:00.000Z");
/** Node E's `valid_to`: eligible strictly before, expired AT it (half-open window). */
const WINDOW_END = "2027-01-01T00:00:00.000Z";

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });

const A = idOf("eoActive");
const B = idOf("eoInactive");
const C = idOf("eoExpired");
const D = idOf("eoNotYet");
const E = idOf("eoWindow");
const F = idOf("eoRetired");
const ALL = [A, B, C, D, E, F];

type Page = { rows: Record<string, unknown>[]; next_after_id: string | null; next_after_updated_at: string | null; total: string | null };

let fixture: Fixture;

const listReq = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: WS,
  after_id: null,
  limit: 100,
  include_total: false,
  type_term: null,
  ...overrides,
});

async function list(overrides: Record<string, unknown>, asOf?: number): Promise<Page> {
  const reader = await openContextReader(fixture.datasetRoot);
  const call = reader.publication.listNodes as (bytes: Uint8Array, requestTimeMs?: number) => Promise<unknown>;
  return (await call(encodeRequest(listReq(overrides)), asOf)) as Page;
}

async function refusal(overrides: Record<string, unknown>, asOf?: number): Promise<any> {
  try {
    await list(overrides, asOf);
  } catch (error) {
    return error;
  }
  throw new Error("expected listNodes to refuse this request, but it succeeded");
}

const ids = (page: Page) => page.rows.map((row) => row.id as string);
const sorted = (values: string[]) => [...values].sort();

beforeAll(async () => {
  fixture = await createFixture([WS]);
  const seeded = fixture.workspaces[WS]!;
  const revs = ALL.map((node) => idOf(`${node.slice(0, 12)}R`));
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({
      ops: [
        pub("publishRevision", { operation_id: "op-eo-a", content: revisionEnvelope(WS, seeded, A) }),
        pub("publishRevision", { operation_id: "op-eo-b", content: revisionEnvelope(WS, seeded, B, { is_active: false }) }),
        pub("publishRevision", {
          operation_id: "op-eo-c",
          content: revisionEnvelope(WS, seeded, C, { valid_from: "2019-01-01T00:00:00.000Z", valid_to: "2020-01-01T00:00:00.000Z" }),
        }),
        pub("publishRevision", { operation_id: "op-eo-d", content: revisionEnvelope(WS, seeded, D, { valid_from: "2099-01-01T00:00:00.000Z" }) }),
        pub("publishRevision", { operation_id: "op-eo-e", content: revisionEnvelope(WS, seeded, E, { valid_to: WINDOW_END }) }),
        pub("publishRevision", { operation_id: "op-eo-f", content: revisionEnvelope(WS, seeded, F) }),
        ctx("retireNode", {
          workspace_name: WS, node_id: F, expected_revision_id: revs[5], reason: "eligible_only: retire F",
          peer_name: null, operation_id: "op-eo-retire-f",
        }),
      ],
      revisionIds: revs,
      clockMs: AS_OF,
    }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  const parsed = JSON.parse(line ?? "{}") as Record<string, any>;
  for (let i = 0; i < 7; i += 1) {
    expect(parsed[`op${i}`]?.ok, `op${i}: ${JSON.stringify(parsed[`op${i}`]).slice(0, 400)}`).toBe(true);
  }
}, testTimeout(180_000));

afterAll(async () => {
  await fixture?.cleanup();
});

describe("listNodes eligible_only (R18 D3): the recall view is the FULL #29 rule", () => {
  test("returns only the nodes that are eligible at as_of: inactive, expired, not-yet-valid and retired all drop out", async () => {
    const page = await list({ eligible_only: true }, AS_OF);
    expect(sorted(ids(page))).toEqual(sorted([A, E]));
    expect(page.next_after_id).toBeNull();
    // Every row this view returns is, by construction, an active one.
    for (const row of page.rows) expect(row.lifecycle_state).toBe("active");
  });

  test("as_of is the caller's request time: the window closes AT valid_to, not after it", async () => {
    const atEnd = Date.parse(WINDOW_END);
    expect(sorted(ids(await list({ eligible_only: true }, atEnd - 1)))).toEqual(sorted([A, E]));
    expect(ids(await list({ eligible_only: true }, atEnd))).toEqual([A]);
  });

  test("membership is exactly getRecallEligibility's own answer, node by node, at two different as_of values", async () => {
    const reader = await openContextReader(fixture.datasetRoot);
    for (const asOf of [AS_OF, Date.parse(WINDOW_END)]) {
      const listed = new Set(ids(await list({ eligible_only: true }, asOf)));
      for (const node of ALL) {
        const verdict = (await reader.context.getRecallEligibility(
          encodeRequest({ workspace_name: WS, node_id: node }),
          asOf,
        )) as { eligible: boolean };
        expect({ node, asOf, listed: listed.has(node) }).toEqual({ node, asOf, listed: verdict.eligible });
      }
    }
  });

  test("opt-in: the DEFAULT view is unchanged -- it still drops only terminal (retired/superseded) nodes", async () => {
    const page = await list({}, AS_OF);
    expect(sorted(ids(page))).toEqual(sorted([A, B, C, D, E]));
    const history = await list({ include_inactive: true, eligible_only: false }, AS_OF);
    expect(sorted(ids(history))).toEqual(sorted(ALL));
  });

  test("keyset paging walks exactly the eligible set, one row per page, in updated_desc order too", async () => {
    for (const order of ["id_asc", "updated_desc"] as const) {
      const seen: string[] = [];
      let afterId: string | null = null;
      let afterUpdatedAt: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const request: Record<string, unknown> = { eligible_only: true, limit: 1, after_id: afterId, order };
        if (order === "updated_desc") request.after_updated_at = afterUpdatedAt;
        const page = await list(request, AS_OF);
        seen.push(...ids(page));
        if (page.next_after_id === null) break;
        afterId = page.next_after_id;
        afterUpdatedAt = page.next_after_updated_at;
      }
      expect({ order, seen: sorted(seen) }).toEqual({ order, seen: sorted([A, E]) });
    }
  });

  test("include_total under eligible_only is null: is_active and the window have no native count, so none is faked", async () => {
    const page = await list({ eligible_only: true, include_total: true }, AS_OF);
    expect(page.total).toBeNull();
    // Contrast: the default view still has its exact native count.
    expect((await list({ include_total: true }, AS_OF)).total).toBe("5");
  });
});

describe("listNodes eligible_only: grammar and clock discipline", () => {
  test("an explicit null or a non-boolean is refused at /eligible_only", async () => {
    for (const bad of [null, "true", 1]) {
      const caught = await refusal({ eligible_only: bad }, AS_OF);
      expect({ bad, code: caught?.code, path: caught?.path }).toEqual({ bad, code: "invalid_request", path: "/eligible_only" });
    }
  });

  test("eligible_only:true with include_inactive:true is a contradiction, refused rather than one silently winning", async () => {
    const caught = await refusal({ eligible_only: true, include_inactive: true }, AS_OF);
    expect(caught?.code).toBe("invalid_request");
    expect(caught?.path).toBe("/eligible_only");
  });

  test("the kernel takes no clock: eligible_only with no (or a non-finite) request time is refused, never defaulted", async () => {
    for (const asOf of [undefined, Number.NaN]) {
      const caught = await refusal({ eligible_only: true }, asOf);
      expect({ asOf: String(asOf), code: caught?.code }).toEqual({ asOf: String(asOf), code: "invalid_request" });
    }
    // Without eligible_only the request time is not needed and not required.
    expect(sorted(ids(await list({})))).toEqual(sorted([A, B, C, D, E]));
  });
});
