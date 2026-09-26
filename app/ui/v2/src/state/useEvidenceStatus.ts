import { useEffect, useRef, useState } from "react";
import type { AssociationResult, DependentOccurrence } from "../api/evidenceReview";
import type { Bank } from "../api/memory";
import type { CitedRevisionStatus, CitingNodeStatus } from "./evidenceStatus.types";
import { resolveCitedRevisions } from "./resolveCitedRevisions";
import { resolveCitingNodes } from "./resolveCitingNodes";

const EMPTY_CITED: ReadonlyMap<string, CitedRevisionStatus> = new Map();
const EMPTY_CITING: ReadonlyMap<string, CitingNodeStatus> = new Map();

/** The live status behind #33 AC3's labels, following whatever direct and
 *  reverse evidence `useEvidenceReview` currently holds. Each lane resets to
 *  an EMPTY map (every label "checking…") the moment its rows change, and a
 *  generation counter drops a lookup that lands after the rows moved on --
 *  the same stale-response guard `useEvidenceReview`'s own lanes use, so node
 *  A's verdicts can never label node B's links. Keyed on the bank's three
 *  strings rather than the `Bank` object, which callers rebuild per render. */
export function useEvidenceStatus(
  b: Bank,
  association: AssociationResult | null,
  occurrences: DependentOccurrence[],
) {
  const [cited, setCited] = useState(EMPTY_CITED);
  const [citing, setCiting] = useState(EMPTY_CITING);
  const citedGen = useRef(0);
  const citingGen = useRef(0);

  useEffect(() => {
    const gen = ++citedGen.current;
    setCited(EMPTY_CITED);
    if (association === null) return;
    void resolveCitedRevisions(b, association.links).then((map) => {
      if (gen === citedGen.current) setCited(map);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.bank, b.workspace, b.token, association]);

  useEffect(() => {
    const gen = ++citingGen.current;
    setCiting(EMPTY_CITING);
    if (occurrences.length === 0) return;
    void resolveCitingNodes(b, occurrences).then((map) => {
      if (gen === citingGen.current) setCiting(map);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.bank, b.workspace, b.token, occurrences]);

  return { cited, citing };
}
