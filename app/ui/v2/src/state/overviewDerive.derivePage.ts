import { type NodeRow, type SessionRow } from "../api/listing";
import { type Sample } from "../api/overview";
import { type PageDerived } from "./overviewDerive";

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
