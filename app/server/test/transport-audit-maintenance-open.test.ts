// #31 maint-audit fix round (2026-09-27): the maintenance-route audit gap is
// OPEN, not ruled. R5 (docs/overnight/DECISIONS.md) says `mcp_calls` and
// `connections` are "written on every request", and the round-4 amendment of
// `authorization-integration-v1.md` already weighed the §4 / no-schema-change
// argument and declined to rule: "**Open for a human:** ... a deviation to
// accept explicitly, not a ruling this amendment can make". A later amendment
// that calls the gap a contract rule narrows a human ruling nobody changed, and
// leaves the frozen contract contradicting itself.
//
// `transport-audit-maintenance.test.ts` pins the BEHAVIOUR (no row anywhere).
// This pins what the durable text may say about it while R5 is unchanged. When
// a human does rule (an R5 amendment accepting the gap, or a home for a
// workspace-less row), the first test fails on purpose: update it, the
// amendment and the `app.ts` comment together.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const HEADING =
  "## Amendment 2026-09-26 (post-merge #31 TODO 'audit consistently across all transports' + R5/R19)";

/** The text from `start` up to the next line that starts with `stop`. */
const section = (text: string, start: string, stop: RegExp) => {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from + start.length);
  const end = rest.search(stop);
  return end < 0 ? rest : rest.slice(0, end);
};

describe("the maintenance-route audit gap stays open for a human", () => {
  test("R5 is unchanged: the operations tables are written on every request", () => {
    const r5 = section(read("../../../docs/overnight/DECISIONS.md"), "## R5 ", /^## /m);
    expect(r5).toContain("written on every request");
    expect(r5).not.toMatch(/maintenance/i);
  });

  test("the maint-audit amendment keeps the round-4 note open and rules nothing", () => {
    const amendment = section(read("../../docs/contracts/authorization-integration-v1.md"), HEADING, /^## /m);
    expect(amendment).toContain("Open for a human");
    expect(amendment).not.toMatch(/by contract/i);
    expect(amendment).not.toMatch(/replaces the round-4/i);
    expect(amendment).not.toMatch(/is read as every admitted, workspace-scoped request/);
  });

  test("the backfill route's comment calls the gap open, not a contract rule", () => {
    const route = section(read("../src/app.ts"), '"/api/backfill",', /^\s+\.(post|get)\(/m);
    expect(route).not.toMatch(/by contract/i);
    expect(route).toMatch(/open for a human/i);
  });
});
