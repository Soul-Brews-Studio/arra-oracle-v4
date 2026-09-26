/**
 * trace-v1 precision evidence (`traces` + `trace_hits`).
 *
 * Scope, per the dispatch: `traces.created_at/updated_at/session_from_ts/
 * session_to_ts` are raw int64 MILLISECONDS; `trace_hits.captured_at` is
 * `timestamp[us]` MICROSECONDS. Both round-trip exactly at their boundaries,
 * and the 1000x mis-scale FAILS LOUDLY if the wrong converter is applied.
 * year-0000 is refused at its field pointer (the accepted grammar), unlike a
 * shape-only check. `friction_score` is float64: NaN/Infinity have no JSON
 * spelling and are refused. `depth` and `position` are int64 at their
 * ceilings. Positions are contiguous 0..n-1; a planted gap is refused.
 *
 * TWO KINDS OF BAD STATE, DELIBERATELY LABELLED, exactly as in the accepted
 * read-cursor/session-link/lifecycle precision lanes: a value this file
 * writes with raw Arrow is ENGINE-ADMITTED corruption -- the store accepted
 * it, so the kernel must reject it on read. Pure-encoder rejection of
 * malformed input, independent of any engine, is core's proof, not this
 * file's; this file never infers engine enforcement from a NOT NULL
 * declaration.
 */

import { describe, expect, test } from "bun:test";
import { runGated } from "./helpers/publication-fixture";
import { createTraceFixture, createTraceRequest, hitInput, traceId, type TraceFixture } from "./helpers/trace-fixture";
import {
  millisToTimestamp,
  timestampToMillis,
  parseCreateTrace,
  TRACE_FIELDS,
  TRACE_HIT_FIELDS,
} from "../src/publication/trace";
import { microsToTimestamp } from "../src/publication/rows";
import { ContractError } from "../src/contracts/errors";

const CHILD = new URL("./fixtures/trace-v1/precision/seed-child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const CLOCK_ISO = new Date(CLOCK_MS).toISOString();
const TEST_TIMEOUT_MS = 600_000;

const MIN_EPOCH_MS = -62135596800000n; // 0001-01-01T00:00:00.000Z
const MAX_EPOCH_MS = 253402300799999n; // 9999-12-31T23:59:59.999Z
const MIN_ISO = "0001-01-01T00:00:00.000Z";
const MAX_ISO = "9999-12-31T23:59:59.999Z";
const INT64_CEILING = 9223372036854775807n; // 2^63 - 1

const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

const drive = async (
  fixture: TraceFixture,
  ops: Array<Record<string, unknown>>,
  clockMs: number | number[] = CLOCK_MS,
): Promise<Record<string, any>> => {
  const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, JSON.stringify({ ops, clockMs })]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1200)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 1200)}`);
  return JSON.parse(line);
};

function rawTraceRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: traceId("rawTrace"),
    workspace_name: ALPHA,
    name: "raw",
    query: "q",
    depth: "0",
    status: "open",
    created_at_millis: CLOCK_MS.toString(10),
    updated_at_millis: CLOCK_MS.toString(10),
    ...overrides,
  };
}

function rawHitRequest(traceIdValue: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_name: ALPHA,
    trace_id: traceIdValue,
    kind: "url",
    ref: "r",
    target: JSON.stringify({ url: "https://example.com" }),
    position: "0",
    ...overrides,
  };
}

describe("pure converters: the 1000x mis-scale fails loudly", () => {
  test("a genuinely microsecond value fed to the MILLIS converter is out of range, not silently wrong", () => {
    // A realistic `trace_hits.captured_at` microsecond value: correct through
    // `microsToTimestamp` (rows.ts), but 1000x too large for `millisToTimestamp`
    // (trace.ts), which this kernel must NEVER apply to it.
    const micros = BigInt(CLOCK_MS) * 1000n;
    expect(microsToTimestamp(micros)).toBe(CLOCK_ISO);

    let error: unknown;
    try {
      millisToTimestamp(micros); // the WRONG converter, deliberately
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    // Out of the Gregorian millisecond range -- fails LOUDLY (integrity_failure),
    // never renders a wrong-but-plausible date five thousand years out.
    const shaped = error as { name?: string; toJSON?: () => Record<string, unknown> };
    expect(shaped.name).toBe("PublicationError");
    expect(shaped.toJSON?.()).toMatchObject({ code: "integrity_failure" });
  });
});

describe("year-0000 is refused at its field pointer, not merely by shape", () => {
  test("parseCreateTrace refuses a leading 0000 year at /session_from_ts, governed", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(
      createTraceRequest(ALPHA, { session_from_ts: "0000-06-15T12:00:00.000Z" }),
    ));
    let error: unknown;
    try {
      parseCreateTrace(bytes);
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).toJSON()).toMatchObject({ code: "invalid_value", path: "/session_from_ts" });
  });

  test("the exported timestampToMillis ALSO refuses year-0000, as defense in depth", () => {
    // Per trace.ts's own header comment: shape + Date-round-trip alone
    // accepts "0000-06-15T12:00:00.000Z" (Date.parse round-trips it
    // identically), which is what makes the SEPARATE Gregorian-floor check
    // inside timestampToMillis load-bearing, not redundant.
    let error: unknown;
    try {
      timestampToMillis("0000-06-15T12:00:00.000Z");
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).toJSON()).toMatchObject({ code: "invalid_value" });
  });
});

describe("all physical columns wire exactly", () => {
  test("a real create with one hit round-trips all 20 trace fields and all 12 hit fields", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const id = traceId("wireTrace");
      // K13 (docs/overnight/V3-PARITY.md): `depth` must actually agree with
      // the resolved `parent_id` chain now, so a depth of 3 needs a REAL
      // three-deep parent chain -- not just an arbitrary wire value -- for
      // this create to succeed at all. Three cheap ancestor creates first.
      const grandparentId = traceId("wireGrandparent");
      const parentId = traceId("wireParent");
      const rootId = traceId("wireRoot");
      const capturedAt = "2026-09-21T00:00:00.456Z";
      const request = createTraceRequest(ALPHA, {
        id,
        parent_id: grandparentId,
        mode: "deep",
        session_id: "ext-session",
        session_from_ts: CLOCK_ISO,
        session_to_ts: CLOCK_ISO,
        friction_score: 0.5,
        confidence: "high",
        depth: "3",
        hits: [hitInput({
          ref: "hit-0", line_start: "1", line_end: "2", excerpt: "e", content_hash: "h", captured_at: capturedAt, note: "n",
        })],
      });
      const parsed = await drive(fixture, [
        ctx("createTrace", createTraceRequest(ALPHA, { id: rootId, parent_id: null, depth: "0" })),
        ctx("createTrace", createTraceRequest(ALPHA, { id: parentId, parent_id: rootId, depth: "1" })),
        ctx("createTrace", createTraceRequest(ALPHA, { id: grandparentId, parent_id: parentId, depth: "2" })),
        ctx("createTrace", request),
        ctx("getTrace", { workspace_name: ALPHA, id }),
        ctx("listTraceHits", { workspace_name: ALPHA, trace_id: id, after_position: null, limit: 10 }),
      ]);
      for (const ancestor of [parsed.op0, parsed.op1, parsed.op2]) {
        expect(ancestor.ok, JSON.stringify(ancestor)).toBe(true);
      }

      const created = parsed.op3;
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(Object.keys(created.value.row)).toEqual([...TRACE_FIELDS]);
      expect(Object.keys(created.value.hits[0])).toEqual([...TRACE_HIT_FIELDS]);
      expect(created.value.row.created_at).toBe(CLOCK_ISO);
      expect(created.value.row.updated_at).toBe(CLOCK_ISO);
      expect(created.value.row.session_from_ts).toBe(CLOCK_ISO);
      expect(created.value.row.session_to_ts).toBe(CLOCK_ISO);
      expect(created.value.row.depth).toBe("3");
      expect(created.value.hits[0].captured_at).toBe(capturedAt);
      expect(created.value.hits[0].position).toBe("0");

      expect(parsed.op4.ok, JSON.stringify(parsed.op4)).toBe(true);
      expect(parsed.op4.value).toEqual(created.value.row as never);
      expect(parsed.op5.ok, JSON.stringify(parsed.op5)).toBe(true);
      expect(parsed.op5.value.rows).toEqual(created.value.hits as never);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("traces: MILLIS Gregorian bounds", () => {
  test("the endpoints render exactly on getTrace; one millisecond outside never does", async () => {
    for (const [ms, iso] of [[MIN_EPOCH_MS, MIN_ISO], [MAX_EPOCH_MS, MAX_ISO]] as [bigint, string][]) {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const id = traceId("bound");
        const parsed = await drive(fixture, [
          hx("insertRawTrace", rawTraceRequest({ id, created_at_millis: ms.toString(10), updated_at_millis: ms.toString(10) })),
          ctx("getTrace", { workspace_name: ALPHA, id }),
        ]);
        expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
        expect(parsed.op1.value.created_at).toBe(iso);
      } finally {
        await fixture.cleanup();
      }
    }

    for (const ms of [MAX_EPOCH_MS + 1n, MIN_EPOCH_MS - 1n]) {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const id = traceId("outside");
        const probe = await drive(fixture, [
          hx("probeRawTrace", rawTraceRequest({ id, created_at_millis: ms.toString(10), updated_at_millis: ms.toString(10) })),
        ]);
        const admission = probe.op0.value as { admitted: boolean; refusal?: { message: string } };
        if (admission.admitted) {
          const parsed = await drive(fixture, [ctx("getTrace", { workspace_name: ALPHA, id })]);
          expect(parsed.op0.ok).toBe(false);
          expect(parsed.op0).toMatchObject({
            name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
          });
        } else {
          expect(admission.refusal!.message.length).toBeGreaterThan(0);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  }, TEST_TIMEOUT_MS);
});

describe("trace_hits: MICROS Gregorian bounds", () => {
  test("the endpoints render exactly on listTraceHits; one microsecond outside never does", async () => {
    for (const [ms, iso] of [[MIN_EPOCH_MS, MIN_ISO], [MAX_EPOCH_MS, MAX_ISO]] as [bigint, string][]) {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const id = traceId("hbound");
        const parsed = await drive(fixture, [
          ctx("createTrace", createTraceRequest(ALPHA, { id, hits: [] })),
          hx("insertRawHit", rawHitRequest(id, { captured_at_micros: (ms * 1000n).toString(10), position: "0" })),
          ctx("listTraceHits", { workspace_name: ALPHA, trace_id: id, after_position: null, limit: 10 }),
        ]);
        expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);
        expect(parsed.op2.value.rows[0].captured_at).toBe(iso);
      } finally {
        await fixture.cleanup();
      }
    }

    for (const ms of [MAX_EPOCH_MS + 1n, MIN_EPOCH_MS - 1n]) {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const id = traceId("houtside");
        const setup = await drive(fixture, [
          ctx("createTrace", createTraceRequest(ALPHA, { id, hits: [] })),
          hx("probeRawHit", rawHitRequest(id, { captured_at_micros: (ms * 1000n).toString(10), position: "0" })),
        ]);
        expect(setup.op0.ok, JSON.stringify(setup.op0)).toBe(true);
        const admission = setup.op1.value as { admitted: boolean; refusal?: { message: string } };
        if (admission.admitted) {
          const parsed = await drive(fixture, [
            ctx("listTraceHits", { workspace_name: ALPHA, trace_id: id, after_position: null, limit: 10 }),
          ]);
          expect(parsed.op0.ok).toBe(false);
          expect(parsed.op0).toMatchObject({
            name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
          });
        } else {
          expect(admission.refusal!.message.length).toBeGreaterThan(0);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  }, TEST_TIMEOUT_MS);
});

describe("friction_score: float64, no JSON spelling for NaN/Infinity", () => {
  test("Infinity and -Infinity are refused at request time", () => {
    // JSON has no literal spelling for NaN or Infinity; JSON.stringify would
    // drop either to `null` before it ever reached the wire. `1e999`/`-1e999`
    // are valid JSON NUMBER tokens that overflow to +-Infinity once parsed to
    // a float64 -- the one way a real client's JSON encoder can put a
    // non-finite value on the wire at all.
    for (const literal of ["1e999", "-1e999"]) {
      const raw = JSON.stringify(createTraceRequest(ALPHA, { friction_score: 0 }))
        .replace('"friction_score":0', `"friction_score":${literal}`);
      let error: unknown;
      try {
        parseCreateTrace(new TextEncoder().encode(raw));
        throw new Error("expected a throw, got none");
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).toJSON()).toMatchObject({ code: "invalid_value", path: "/friction_score" });
    }
  });

  test("an engine-admitted NaN/Infinity fails closed on read, never silently coerced", async () => {
    // JSON has no wire spelling for these, so the plan carries a string
    // MARKER the seed child decodes back into a real NaN/Infinity right
    // before the Arrow column is built -- a bare JS `NaN`/`Infinity` here
    // would already collapse to `null` in `JSON.stringify`, testing nothing.
    for (const bad of ["__NaN__", "__Infinity__", "__-Infinity__"]) {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const id = traceId("friction");
        const probe = await drive(fixture, [
          hx("probeRawTrace", rawTraceRequest({ id, friction_score: bad })),
        ]);
        const admission = probe.op0.value as { admitted: boolean; refusal?: { message: string } };
        if (admission.admitted) {
          const parsed = await drive(fixture, [ctx("getTrace", { workspace_name: ALPHA, id })]);
          expect(parsed.op0.ok).toBe(false);
          expect(parsed.op0).toMatchObject({
            name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
          });
        } else {
          expect(admission.refusal!.message.length).toBeGreaterThan(0);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  }, TEST_TIMEOUT_MS);
});

describe("depth and position: int64 at their ceilings, and a stored negative", () => {
  test("depth at the Int64 ceiling renders as exact decimal TEXT; a stored negative depth fails closed", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const idCeiling = traceId("depthCeil");
      const idNegative = traceId("depthNeg");
      const parsed = await drive(fixture, [
        hx("insertRawTrace", rawTraceRequest({ id: idCeiling, depth: INT64_CEILING.toString(10) })),
        ctx("getTrace", { workspace_name: ALPHA, id: idCeiling }),
        hx("insertRawTrace", rawTraceRequest({ id: idNegative, depth: "-1" })),
        ctx("getTrace", { workspace_name: ALPHA, id: idNegative }),
      ]);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op1.value.depth).toBe(INT64_CEILING.toString(10));
      expect(typeof parsed.op1.value.depth).toBe("string");

      expect(parsed.op3.ok).toBe(false);
      expect(parsed.op3).toMatchObject({
        name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("position at the Int64 ceiling renders as exact decimal TEXT via a keyset read past its own cursor", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const id = traceId("posCeil");
      const parsed = await drive(fixture, [
        ctx("createTrace", createTraceRequest(ALPHA, { id, hits: [] })),
        hx("insertRawHit", rawHitRequest(id, { position: INT64_CEILING.toString(10) })),
        ctx("listTraceHits", {
          workspace_name: ALPHA, trace_id: id,
          after_position: (INT64_CEILING - 1n).toString(10), limit: 10,
        }),
      ]);
      expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);
      expect(parsed.op2.value.rows).toHaveLength(1);
      expect(parsed.op2.value.rows[0].position).toBe(INT64_CEILING.toString(10));
      expect(typeof parsed.op2.value.rows[0].position).toBe("string");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("positions are contiguous 0..n-1; a planted gap is refused", () => {
  test("a stored gap (0, then 2, skipping 1) is integrity_failure at ROOT", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const id = traceId("gapTrace");
      const parsed = await drive(fixture, [
        ctx("createTrace", createTraceRequest(ALPHA, { id, hits: [] })),
        hx("insertRawHit", rawHitRequest(id, { position: "0", ref: "hit-0" })),
        hx("insertRawHit", rawHitRequest(id, { position: "2", ref: "hit-2" })),
        ctx("listTraceHits", { workspace_name: ALPHA, trace_id: id, after_position: null, limit: 10 }),
      ]);
      expect(parsed.op3.ok).toBe(false);
      expect(parsed.op3).toMatchObject({
        name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
