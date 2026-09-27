import { useEffect, useMemo, useState } from "react";
import type { RevisionRow } from "../api/knowledge";
import type { CiteTarget } from "./linkDraft.types";
import { mergeCiteTargets } from "./mergeCiteTargets";

const toTarget = (r: RevisionRow): CiteTarget => ({
  node_id: r.node_id,
  revision_id: r.id,
  revision_no: r.revision_no,
  title: r.title,
});

/** Revisions the link editor may offer as picks: every head this view has
 *  loaded since the workspace was chosen, plus the open node's history.
 *  Session memory only -- nothing enumerates nodes (see `api/knowledge.ts`),
 *  so "what can I cite" is "what have I looked at", and ids can always be
 *  typed instead. */
export function useCiteTargets(scope: string, head: RevisionRow | null, history: RevisionRow[]): CiteTarget[] {
  const [seen, setSeen] = useState<CiteTarget[]>([]);
  useEffect(() => setSeen([]), [scope]);
  useEffect(() => {
    if (head !== null) setSeen((s) => mergeCiteTargets(s, [toTarget(head)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.id]);
  return useMemo(() => mergeCiteTargets(seen, history.map(toTarget)), [seen, history]);
}
