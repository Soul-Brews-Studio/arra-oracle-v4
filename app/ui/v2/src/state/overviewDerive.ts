/** The pure half of the overview state: everything computed FROM a finished
 *  volley, with no fetching and no React in it.
 *
 * Split from `useOverview.ts` because these are the functions that decide
 * what is known and what merely looks known -- the subtlest code on the page,
 * and the part worth reading without a hook wrapped around it.
 *
 * One rule runs through all of them: a derivation over rows that were never
 * returned is null, not zero. Every function here takes the probe's outcome
 * as well as its rows, because the rows alone cannot say whether they are a
 * sample, the whole set, or the empty array a failed request decodes to.
 */
import { type ApiResult } from "../api/client";
import { type NodeRow, type SessionRow } from "../api/listing";
import { type Sample } from "../api/overview";
import { type TypeCount } from "../api/typeCount";

export type HealthInfo = { ok: boolean; version: string | null; auth: string | null; durationMs: number };

/** Sublines computed over the RETURNED PAGE, never by the server -- so both go
 *  null the moment the set did not fit on one page, rather than quietly
 *  describing the first fifty rows as if they were all of them. */
export type PageDerived = { activeSessions: number | null; revisions: string | null };

/** The mock's `Σ 5 = nodes total ✓`. Two independent measurements of the same
 *  set, so checking them against each other is free evidence -- and when they
 *  cannot be compared (no total, no sum, or any floor among the parts) that is
 *  `null` rather than `false`: "not checkable" is not "disagrees". */
export type ByTypeCheck = { sum: number | null; allExact: boolean; matchesTotal: boolean | null };

/** BigInt, not `+`. `revision_no` is Int64 decimal TEXT and summing it through
 *  Number is the precision bug `knowledge.ts` warns about; the result stays a
 *  string for the same reason. A row whose value does not parse makes the whole
 *  sum a guess, so the answer is null -- one unreadable row must not silently
 *  count as zero. */
function sumRevisions(rows: NodeRow[]): string | null {
  let sum = 0n;
  for (const row of rows) {
    if (!/^-?\d+$/.test(row.revision_no)) return null;
    sum += BigInt(row.revision_no);
  }
  return sum.toString(10);
}

/** A page is a claim about the whole set only when the count behind it came
 *  back AND no cursor followed it. Both conditions, because a failed request
 *  also arrives with no cursor: summing THAT page yields "0 revisions" printed
 *  directly under the em dash that admits the number is unknown. */
const whole = <T>(sample: Sample<T>): boolean => sample.count.outcome === "counted" && sample.terminal;

export function derivePage(sessions: Sample<SessionRow>, nodes: Sample<NodeRow>): PageDerived {
  return {
    activeSessions: whole(sessions) ? sessions.rows.filter((r) => r.is_active).length : null,
    revisions: whole(nodes) ? sumRevisions(nodes.rows) : null,
  };
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

export function toHealth(result: ApiResult): HealthInfo {
  const body = (result.ok && typeof result.body === "object" && result.body !== null
    ? result.body
    : {}) as Record<string, unknown>;
  return {
    ok: result.ok,
    version: typeof body.version === "string" ? body.version : null,
    auth: typeof body.auth === "string" ? body.auth : null,
    durationMs: result.durationMs,
  };
}
