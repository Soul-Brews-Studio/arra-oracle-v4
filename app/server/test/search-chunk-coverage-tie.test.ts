// Chain-coverage slice (issue #31, finding item 3): nothing tied
// search.retrieve.ts's local `KernelCoverage` type to the kernel's own
// `publication/search-chunk.coverageSignal.ts` `CoverageSignal` at compile
// time. Every v3 test stubs `kb` with hand-written field names
// (`coverage`/`coverage_reason`/`candidate_ceiling`); if the kernel ever
// renamed one of them, those stubs would keep matching themselves and every
// warning would quietly stop firing with the whole suite still green
// (docs/overnight/DECISIONS.md R21/R22; V3-PARITY.md A1's "no import from
// `publication/*`" is an ADAPTER rule -- this is a test file, not the
// adapter, so it may import both sides and tie them).
//
// Two ties, both real:
//  1. compile-time: `AssertAssignable` below fails `bun run typecheck` if
//     either type stops matching the other in either direction.
//  2. runtime: a real `coverageSignal()` call (the kernel's own factory) is
//     asserted to hold exactly the three keys `KernelCoverage` expects, at
//     both of its two possible shapes (saturated and not).

import { describe, expect, test } from "bun:test";
import { coverageSignal, type CoverageSignal } from "../src/publication/search-chunk.coverageSignal";
import type { KernelCoverage } from "../src/mcp/legacy-v3/search.retrieve";

type AssertAssignable<Target, Value extends Target> = Value;
type _KernelCoverageSatisfiesCoverageSignal = AssertAssignable<CoverageSignal, KernelCoverage>;
type _CoverageSignalSatisfiesKernelCoverage = AssertAssignable<KernelCoverage, CoverageSignal>;

describe("search.retrieve.ts's local KernelCoverage stays tied to publication/search-chunk.coverageSignal.ts's CoverageSignal", () => {
  test("a real kernel CoverageSignal value satisfies the adapter's local type, at both of its two shapes", () => {
    const full = coverageSignal(false, 4096);
    const partial = coverageSignal(true, 4096);
    for (const value of [full, partial]) {
      // The compile-time tie, exercised directly: if this assignment stopped
      // typechecking, `bun run typecheck` fails here, not silently elsewhere.
      const asKernelCoverage: KernelCoverage = value;
      expect(Object.keys(asKernelCoverage).sort()).toEqual(["candidate_ceiling", "coverage", "coverage_reason"]);
    }
    expect(full).toEqual({ coverage: "full", coverage_reason: null, candidate_ceiling: 4096 });
    expect(partial).toEqual({ coverage: "partial", coverage_reason: "candidate_ceiling", candidate_ceiling: 4096 });
  });
});
