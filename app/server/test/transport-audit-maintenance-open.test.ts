// #31 maint-audit fix round (2026-09-27) left the maintenance-route audit gap
// OPEN, pinned here so a later edit could not quietly call it "by contract"
// without an actual human ruling. That ruling has now happened: Nat
// 2026-09-28 NAT-DECISIONS D4b closes the gap with a separate instance-level
// audit log (see the amendment this file now pins, and
// `transport-audit-instance.test.ts` for the behaviour). This file moves with
// the ruling, exactly as its own prior text said it would.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const HEADING =
  "## Amendment 2026-09-26 (post-merge Nat 2026-09-28 NAT-DECISIONS D4b: a separate instance-level audit log for /api/backfill and /api/reindex)";

/** The text from `start` up to the next line that starts with `stop`. */
const section = (text: string, start: string, stop: RegExp) => {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from + start.length);
  const end = rest.search(stop);
  return end < 0 ? rest : rest.slice(0, end);
};

describe("D4b rules the maintenance-route audit gap: a separate instance-level log", () => {
  test("R5 is still unchanged: it names the tenant tables, not the new sink", () => {
    const r5 = section(read("../../../docs/overnight/DECISIONS.md"), "## R5 ", /^## /m);
    expect(r5).toContain("written on every request");
    expect(r5).not.toMatch(/instance_audit/i);
  });

  test("the D4b amendment names the separate sink and does not touch mcp_calls/connections schema", () => {
    const amendment = section(read("../../docs/contracts/authorization-integration-v1.md"), HEADING, /^## /m);
    expect(amendment).toMatch(/instance_audit/);
    expect(amendment).toMatch(/UNCHANGED/);
    expect(amendment).not.toMatch(/accept a sentinel workspace/i);
  });

  test("the backfill route's comment points at the instance sink, not 'open for a human'", () => {
    const route = section(read("../src/app.createApp.ts"), '"/api/backfill",', /^\s+\.(post|get)\(/m);
    expect(route).not.toMatch(/open for a human/i);
    expect(route).toMatch(/instance-level audit sink/i);
  });
});
