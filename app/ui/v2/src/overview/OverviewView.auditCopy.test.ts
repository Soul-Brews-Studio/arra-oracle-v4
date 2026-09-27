/** Failing-first (#31 legacy-audit fix round, 2026-09-27). The verifier's
 *  blocking finding: after the legacy HTTP memory routes started writing
 *  audit rows (GET/POST /api/memories, GET /api/search, GET /api/health, as
 *  their MCP twins), the "mcp calls" card still printed
 *  "admitted MCP + HTTP knowledge calls · legacy routes not logged" under a
 *  number that COUNTS those rows -- while its own hover hint (`MCP_WHY`) said
 *  they were logged. One card, two claims, one false; and the committed
 *  bundle shipped the false one.
 *
 * Why a copy scan and not a render: the card's subline only renders once
 * `useOverview`'s volley has COUNTED (`whenCounted`), and a static render
 * never runs that effect. What this pins is the text itself, in the source
 * and in the bundle the server actually ships (`app/server/public/v2`), so a
 * stale rebuild fails too. `bun test src/overview/OverviewView.auditCopy.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("./OverviewView.tsx", import.meta.url), "utf8");
const PUBLIC = new URL("../../../../server/public/v2/", import.meta.url);

/** A claim that the legacy memory routes are NOT audited. */
const LEGACY_UNLOGGED = /legacy[^"\n]{0,40}\bnot (logged|audited|counted)/i;

const literal = (pattern: RegExp) => {
  const hit = SOURCE.match(pattern)?.[1];
  if (hit === undefined) throw new Error(`no match for ${pattern} in OverviewView.tsx`);
  return hit;
};
const MCP_SUB = literal(/whenCounted\(c\.mcpCalls, "([^"]*)"\)/);
const MCP_WHY = literal(/const MCP_WHY =\s*"([^"]*)"/);

describe("the 'mcp calls' card states one scope, and it is true", () => {
  test("the subline no longer says legacy routes are not logged", () => {
    expect(MCP_SUB).not.toMatch(LEGACY_UNLOGGED);
    expect(MCP_WHY).not.toMatch(LEGACY_UNLOGGED);
  });

  test("subline and hint agree on what is NOT logged: the maintenance routes", () => {
    expect(MCP_WHY).toContain("/api/memories");
    expect(MCP_WHY).toContain("maintenance routes");
    expect(MCP_SUB).toContain("maintenance routes not logged");
  });

  test("the shipped bundle carries the same subline, not the stale one", () => {
    const index = readFileSync(new URL("index.html", PUBLIC), "utf8");
    const src = index.match(/<script[^>]*src="\/v2\/(assets\/[^"]+\.js)"/)?.[1];
    expect(src, "index.html names its bundle").toBeDefined();
    const bundle = readFileSync(new URL(src!, PUBLIC), "utf8");
    // Booleans, so a failure prints the stale phrase and not 300 KB of bundle.
    expect(bundle.match(LEGACY_UNLOGGED)?.[0] ?? null, src).toBeNull();
    expect(bundle.includes(MCP_SUB), `${src} carries "${MCP_SUB}"`).toBe(true);
  });
});
