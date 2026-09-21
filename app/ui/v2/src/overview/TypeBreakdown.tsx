import { TYPE_TERMS, type TypeTerm } from "../api/knowledge";
import type { TypeCount } from "../api/typeCount";
import { TypeBadge } from "../components/TypeBadge";
import { StatGrid } from "./StatGrid";

/** The five sealed `type` terms and how many nodes carry each.
 *
 * This takes `api/typeCount.ts`'s `TypeCount` verbatim rather than a flattened
 * prop of its own. The seam is worth avoiding: that type says `atLeast` +
 * `exact`, and a caller retyping those as a count plus a "bounded" flag has
 * one chance in two of inverting the boolean -- which would print a floor as
 * a total, silently, in the one place on this page whose whole job is not to.
 *
 * Why the numbers are floors at all, and why one can be null, is documented
 * where they are produced -- `api/typeCount.ts`. What matters here: these are
 * rows we counted, exact only while one page holds them all.
 *
 * Every term renders even at zero -- `TYPE_TERMS` is sealed server-side, so
 * a missing row could only mean we forgot to ask.
 */
export type TypeCounts = Partial<Record<TypeTerm, TypeCount>>;

/** Σ, but only when summing is honest: every term probed, supported, exact,
 *  and actually measured. One bounded floor or one unmeasured call makes the
 *  total meaningless, so there is no total. */
function exactSum(counts: TypeCounts): number | null {
  let total = 0;
  for (const term of TYPE_TERMS) {
    const c = counts[term];
    if (c === undefined || !c.supported || !c.exact || c.atLeast === null) return null;
    total += c.atLeast;
  }
  return total;
}

/** Compared through BigInt, not Number. The per-type side is a row count and
 *  genuinely small, but `nodesTotal` is an Int64 decimal string off the wire
 *  -- parsing THAT is the precision bug `api/knowledge.ts` warns about, and a
 *  cross-check that can quietly go wrong is worse than none. */
function crossCheck(sum: number | null, nodesTotal: string | null): { text: string; cls: string } {
  // Three reasons the sum can be missing -- unprobed, bounded by the page
  // limit, or unmeasurable -- and one honest line covers all three.
  if (sum === null) return { text: "Σ — · a per-type count is missing or bounded, so the check cannot run", cls: "" };
  // "≠" claims two measurements CONFLICT. With no unfiltered total there is
  // only one measurement, so this takes the same "cannot run" line the
  // missing-sum case gets -- not an amber disagreement with an em dash.
  if (nodesTotal === null) {
    return { text: `Σ ${sum} · the unfiltered nodes total is unknown, so the check cannot run`, cls: "" };
  }
  try {
    if (BigInt(sum) === BigInt(nodesTotal)) return { text: `Σ ${sum} = nodes total ✓`, cls: "text-accent" };
  } catch {
    /* a non-numeric total is not a match; fall through to the mismatch line */
  }
  return { text: `Σ ${sum} ≠ nodes total ${nodesTotal}`, cls: "text-[#f0a35e]" };
}

/** Bar width only -- the one safe coercion here, because a pixel length is
 *  approximate by nature and the label above the bar is never parsed. */
function barPercent(part: number, total: string | null): number | null {
  if (total === null) return null;
  const whole = Number(total);
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

export function TypeBreakdown({
  counts,
  nodesTotal,
  limit,
}: {
  counts: TypeCounts;
  /** The unfiltered `listNodes` total: denominator, and the other side of Σ. */
  nodesTotal: string | null;
  /** The page limit the counts were taken under -- what `≥` is relative to. */
  limit: number;
}) {
  const check = crossCheck(exactSum(counts), nodesTotal);
  return (
    <StatGrid
      label={
        <span>
          <span className="font-semibold uppercase tracking-wide">node types</span> · sealed, exactly one per revision ·{" "}
          <span className={check.cls}>{check.text}</span>
        </span>
      }
      note={`† a type-filtered list carries no total by design, so these are counted rows — exact only while one page holds them all. At the limit (${limit}) a term reads "≥ ${limit}", never a guessed total.`}
    >
      {TYPE_TERMS.map((term) => (
        <TypeCell key={term} term={term} count={counts[term]} nodesTotal={nodesTotal} />
      ))}
    </StatGrid>
  );
}

function TypeCell({ term, count, nodesTotal }: { term: TypeTerm; count?: TypeCount; nodesTotal: string | null }) {
  // Two ways to know nothing, both an em dash rather than a zero: no entry
  // at all (nothing probed this term), or a null `atLeast` (empty page AND a
  // failed unfiltered count, so the two cannot be told apart).
  const probed = count !== undefined;
  const rows = probed && count.supported ? count.atLeast : null;
  const percent = rows === null ? null : barPercent(rows, nodesTotal);
  // `note` is non-null exactly when the number needs a caveat: absent method,
  // a floor, an unmeasured call, or a zero a filtered call cannot tell from a
  // failure. So the caveat drives the colour, and a clean count needs no
  // special case.
  const caveat = probed ? count.note : "not probed yet";

  return (
    <div
      title={caveat ?? `counted ${rows} rows; a type-filtered list carries no total`}
      className={`rounded border border-edge p-3 ${probed && count.supported ? "bg-panel" : "border-dashed bg-ink"}`}
    >
      <TypeBadge type={term} />
      {!probed || !count.supported ? (
        <p className="mt-1.5 text-sm text-muted">{probed ? "not on this server" : "—"}</p>
      ) : (
        <p className={`mt-1.5 text-xl font-semibold tabular-nums ${caveat === null ? "text-slate-100" : "text-[#f0a35e]"}`}>
          {rows === null ? "—" : count.exact ? rows : `≥ ${rows}`}
        </p>
      )}
      <div className="mt-1.5 h-1 w-full rounded bg-edge">
        {percent !== null && (
          <div className={`h-1 rounded ${caveat === null ? "bg-accent" : "bg-[#f0a35e]"}`} style={{ width: `${percent}%` }} />
        )}
      </div>
      <p className="mt-1 text-[10px] text-muted">
        {percent === null ? "— of nodes" : `${count?.exact ? "" : "≥ "}${percent.toFixed(0)}% of nodes`}
      </p>
    </div>
  );
}
