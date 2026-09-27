import { type TypeCount } from "../api/typeCount";
import { type ByTypeCheck } from "./overviewDerive";

function matches(sum: number | null, allExact: boolean, nodesTotal: string | null): boolean | null {
  if (sum === null || !allExact || nodesTotal === null) return null;
  // BigInt both sides: `nodesTotal` is Int64 decimal TEXT off the wire, and a
  // cross-check that can quietly go wrong is worse than no cross-check.
  try {
    return BigInt(sum) === BigInt(nodesTotal);
  } catch {
    return false; // a non-numeric total is not a match, but it IS an answer
  }
}

export function deriveByTypeCheck(byType: TypeCount[], nodesTotal: string | null): ByTypeCheck {
  // One unmeasured term poisons the sum: `Σ 4` over five terms where the
  // fifth is unknown is a smaller lie than `Σ 0`, but still a lie.
  const parts = byType.map((t) => t.atLeast);
  const sum = byType.length === 0 || parts.some((n) => n === null)
    ? null
    : parts.reduce<number>((n, part) => n + (part ?? 0), 0);
  const allExact = byType.length > 0 && byType.every((t) => t.exact);
  return { sum, allExact, matchesTotal: matches(sum, allExact, nodesTotal) };
}
