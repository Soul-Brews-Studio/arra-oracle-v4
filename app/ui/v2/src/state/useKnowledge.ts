/** Server state for the knowledge tier: nodes, revisions, type and tags.
 *
 * Sibling of `useMemory`. Same discipline -- every request in this lane is
 * issued here, and the components stay presentational.
 *
 * Two things are persisted in localStorage rather than fetched, and both are
 * forced by the same server property (no enumeration endpoint, issue #88):
 *
 *   - the node roster, a bookmark list exactly like peers and sessions
 *   - the TAXONOMY IDS, which is the sharper one. `getVocabulary` and
 *     `getTerm` take ids, not names, and the ids are minted by this client at
 *     seed time. Lose them and the vocabularies still exist on the server but
 *     become unreachable by this UI, because nothing maps "type" back to its
 *     vocabulary_id. That is a real consequence and the setup panel says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiResult } from "../api/client";
import { type Bank, asError } from "../api/memory";
import {
  type PublishInput,
  type RevisionRow,
  type TaxonomyIds,
  type TermSnapshot,
  getAcceptedHead,
  listAcceptedHistory,
  mintTaxonomyIds,
  parseTerms,
  publishRevision,
  seedReservedVocabularies,
} from "../api/knowledge";
import { interpretPublishResult } from "./interpretPublishResult";
import { type Entry, addName, removeName, setState } from "./roster";
import { useStableBank } from "./useStableBank";

const NODES_KEY = "arra-ui-v2-nodes";
const TAX_KEY = "arra-ui-v2-taxonomy";

function describe(result: ApiResult): string {
  if (result.error !== undefined) return result.error;
  const envelope = asError(result.body);
  if (envelope !== null) {
    return envelope.pointer !== undefined && envelope.pointer !== ""
      ? `${envelope.code} at ${envelope.pointer}`
      : String(envelope.code);
  }
  return `HTTP ${result.status}`;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode: bookmarks are a convenience, never load-bearing */
  }
}

export function useKnowledge(bank: Bank) {
  // Keyed on the three strings, not the caller's object: `refresh` depends on
  // `b`, and a parent that builds the bank inline would refetch on every render.
  const b = useStableBank(bank);
  const scope = `${b.bank}:${b.workspace}`;
  const [nodes, setNodes] = useState<Entry[]>(() => loadJson<Entry[]>(`${NODES_KEY}:${scope}`, []));
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [taxonomy, setTaxonomy] = useState<TaxonomyIds | null>(() =>
    loadJson<TaxonomyIds | null>(`${TAX_KEY}:${scope}`, null),
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [head, setHead] = useState<{ node: unknown; revision: RevisionRow | null } | null>(null);
  const [history, setHistory] = useState<RevisionRow[]>([]);
  const [snapshotHead, setSnapshotHead] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which `refresh` is current. Every await below re-checks it, so a response
  // for a node already navigated away from (or a bank already left) is
  // dropped instead of painting that node's head under the new node's id --
  // the ui-stale bug, where the LAST response to arrive won.
  const gen = useRef(0);

  useEffect(() => {
    setNodes(loadJson<Entry[]>(`${NODES_KEY}:${scope}`, []));
    setTaxonomy(loadJson<TaxonomyIds | null>(`${TAX_KEY}:${scope}`, null));
    setSelected(null);
    setHead(null);
    setHistory([]);
  }, [scope]);

  useEffect(() => saveJson(`${NODES_KEY}:${scope}`, nodes), [scope, nodes]);
  useEffect(() => {
    if (taxonomy !== null) saveJson(`${TAX_KEY}:${scope}`, taxonomy);
  }, [scope, taxonomy]);

  const refresh = useCallback(async () => {
    const g = ++gen.current;
    if (selected === null) {
      setHead(null);
      setHistory([]);
      return;
    }
    setLoading(true);
    setError(null);
    const headResult = await getAcceptedHead(b, selected);
    if (g !== gen.current) return; // superseded by a newer selection or refresh
    if (!headResult.ok) {
      setLoading(false);
      setHead(null);
      setHistory([]);
      setError(describe(headResult));
      setNodes((n) => setState(n, selected, "unknown"));
      return;
    }
    // A null body is the server saying "no such node", which is an ANSWER --
    // the bookmark is stale, not the request malformed.
    const body = headResult.body as { node?: unknown; revision?: RevisionRow } | null;
    if (body === null || body.revision === undefined) {
      setLoading(false);
      setHead(null);
      setHistory([]);
      setNodes((n) => setState(n, selected, "missing"));
      return;
    }
    setNodes((n) => setState(n, selected, "live"));
    setTitles((t) => ({ ...t, [selected]: body.revision!.title }));
    setHead({ node: body.node, revision: body.revision });

    const historyResult = await listAcceptedHistory(b, selected);
    if (g !== gen.current) return;
    setLoading(false);
    if (!historyResult.ok) {
      setHistory([]);
      setError(describe(historyResult));
      return;
    }
    // THIRD envelope key in this API, and they are all different:
    //   listMessages         -> { rows }
    //   getContext           -> { items }
    //   listAcceptedHistory  -> { node, snapshot_head_revision_id, revisions }
    // None of them errors when you read the wrong one; you just get an empty
    // list against a server that returned data. Verified by curl, not guessed.
    const historyBody = historyResult.body as {
      revisions?: unknown;
      snapshot_head_revision_id?: unknown;
    } | null;
    setHistory(Array.isArray(historyBody?.revisions) ? (historyBody.revisions as RevisionRow[]) : []);
    // The server states its own head here, so prefer it over re-deriving one
    // from the separate getAcceptedHead call -- one snapshot, one answer.
    if (typeof historyBody?.snapshot_head_revision_id === "string") {
      setSnapshotHead(historyBody.snapshot_head_revision_id);
    }
  }, [b, selected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Every term this client can actually see, flattened. The cloud built from
   *  this covers LOCAL revisions only -- there is no way to survey the
   *  workspace, and `TermCloudEmpty` says so rather than implying coverage. */
  const allTerms: TermSnapshot[] = useMemo(() => {
    const out: TermSnapshot[] = [];
    for (const revision of history) out.push(...parseTerms(revision));
    if (head?.revision != null) out.push(...parseTerms(head.revision));
    return out;
  }, [history, head]);

  const actions = {
    addNode: (id: string) => setNodes((n) => addName(n, id)),
    removeNode: (id: string) => {
      setNodes((n) => removeName(n, id));
      if (selected === id) setSelected(null);
    },
    seed: async () => {
      setBusy(true);
      setError(null);
      const ids = taxonomy ?? mintTaxonomyIds();
      const result = await seedReservedVocabularies(b, ids);
      setBusy(false);
      // `already_seeded` is a success for this UI's purpose: the vocabularies
      // exist and these are the ids that reach them.
      if (!result.ok) {
        setError(describe(result));
        return;
      }
      setTaxonomy(ids);
    },
    // `base` overrides the head-as-base default: a correction is a NEW node,
    // so it passes `null` even while another node's head is on screen.
    // Resolves `true` unless the server refused: a transport failure
    // (`!result.ok`), or a `conflict` outcome (stale base, retired/
    // superseded node, id clash) -- a 200 that refused to write. Both are
    // told apart by `interpretPublishResult`, which also surfaces the
    // server's refusal reason through `error`, exactly like a transport
    // failure would.
    publish: async (
      input: Omit<PublishInput, "node_id" | "base_revision_id">,
      nodeId: string,
      base?: string | null,
    ): Promise<boolean> => {
      if (taxonomy === null) {
        setError("seed the reserved vocabularies first -- a revision needs exactly one type term");
        return false;
      }
      setPublishing(true);
      setError(null);
      const result = await publishRevision(b, taxonomy, {
        ...input,
        node_id: nodeId,
        // An edit must name the CURRENT head as its base. Passing the wrong
        // one is refused rather than silently overwriting, which is how a
        // lost update surfaces as an error instead of as missing history.
        base_revision_id: base !== undefined ? base : (head?.revision?.id ?? null),
      });
      setPublishing(false);
      const interpreted = interpretPublishResult(result, describe);
      if (!interpreted.ok) {
        setError(interpreted.error);
        return false;
      }
      setNodes((n) => addName(n, nodeId));
      setSelected(nodeId);
      await refresh();
      return true;
    },
    refresh,
  };

  return {
    nodes, titles, taxonomy, selected, setSelected,
    head, history, snapshotHead, allTerms,
    loading, error, publishing, busy,
    actions,
  };
}
