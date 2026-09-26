/**
 * `oracle_trace`'s dig points (V3-PARITY.md §4.2, slice V3). A thin barrel,
 * style matched to `publication/trace.ts`: one function per file, named
 * `trace-hits.<name>.ts` beside this one, re-exported here so the public
 * surface (`../trace-hits`) is unchanged. Fix round: this file used to hold
 * both `buildTraceHits` and `readTraceHits` directly, neither named after
 * it, unlike every other file under `legacy-v3/` (`taxonomy.termSnapshot.ts`,
 * `ids.derivedId.ts`, …).
 */

export { type TraceHitsBuild, buildTraceHits } from "./trace-hits.buildTraceHits";
export { type TraceFoundArrays, readTraceHits } from "./trace-hits.readTraceHits";
