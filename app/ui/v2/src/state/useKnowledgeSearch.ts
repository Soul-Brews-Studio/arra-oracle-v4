/** Server state for the knowledge search box (#30/#33): keyword and semantic
 *  retrieval, kept in one hook so the component stays presentational, same
 *  discipline as `useKnowledge`/`useMemory`.
 *
 * Debounced by a plain timer plus a request-id guard (not an AbortController
 * -- this POC's other hooks don't use one either, and a stale response here
 * only means "briefly render last query's hits", never a wrong write): a
 * keystroke a user is still typing should not fire a request per character,
 * and a reply for a since-abandoned query must never overwrite a later one's
 * result.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiResult } from "../api/client";
import { type Bank, asError } from "../api/memory";
import { searchKnowledgeKeyword, searchKnowledgeSemantic } from "../api/search";
import { type KeywordHitWire, type SemanticHitWire } from "./searchHitView";

export type SearchMode = "keyword" | "semantic";

const DEBOUNCE_MS = 300;

function describe(result: ApiResult): string {
  if (result.error !== undefined) return result.error;
  const envelope = asError(result.body);
  if (envelope !== null) return String(envelope.code);
  return `HTTP ${result.status}`;
}

export function useKnowledgeSearch(bank: Bank) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("keyword");
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [keywordHits, setKeywordHits] = useState<KeywordHitWire[]>([]);
  const [semanticHits, setSemanticHits] = useState<SemanticHitWire[]>([]);
  const [scanReason, setScanReason] = useState<"short_query" | "index_unavailable" | null>(null);
  const [embeddingProfile, setEmbeddingProfile] = useState<string | null>(null);

  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (q: string, m: SearchMode) => {
      const id = ++requestId.current;
      if (q.trim() === "") {
        setLoading(false);
        setErrorCode(null);
        setKeywordHits([]);
        setSemanticHits([]);
        setScanReason(null);
        return;
      }
      setLoading(true);
      setErrorCode(null);
      const result = m === "keyword" ? await searchKnowledgeKeyword(bank, q) : await searchKnowledgeSemantic(bank, q);
      if (id !== requestId.current) return; // a newer query has already started
      setLoading(false);
      if (!result.ok) {
        setErrorCode(describe(result));
        setKeywordHits([]);
        setSemanticHits([]);
        setScanReason(null);
        return;
      }
      if (m === "keyword") {
        const body = result.body as { hits?: KeywordHitWire[]; scan_reason?: "short_query" | "index_unavailable" | null };
        setKeywordHits(Array.isArray(body.hits) ? body.hits : []);
        setScanReason(body.scan_reason ?? null);
      } else {
        const body = result.body as { hits?: SemanticHitWire[]; embedding_profile?: string };
        setSemanticHits(Array.isArray(body.hits) ? body.hits : []);
        setEmbeddingProfile(body.embedding_profile ?? null);
      }
    },
    [bank],
  );

  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(query, mode), DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, bank.bank, bank.workspace, bank.token]);

  return {
    query,
    setQuery,
    mode,
    setMode,
    loading,
    errorCode,
    hits: mode === "keyword" ? keywordHits : semanticHits,
    scanReason,
    embeddingProfile,
  };
}
