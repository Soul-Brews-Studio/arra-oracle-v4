/**
 * Shared builders and vocabulary for the v3-compatible tool catalogue
 * (`catalogue.ts`). Split out purely to keep files under the repo's line
 * cap -- no behaviour here, just the `V3ToolSpec` shape, the JSON-schema
 * micro-builders (`str`/`int`/`strings`/`obj`), `spec()`'s freeze step, and
 * the description fragments/method-name groups the catalogue entries reuse.
 */

import type { WorkspaceAction } from "../../auth/policy";

export type V3ToolSpec = {
  readonly name: string;
  readonly action: Extract<WorkspaceAction, "content:read" | "content:write">;
  readonly alsoNeeds?: readonly Extract<WorkspaceAction, "content:read">[];
  readonly uses: readonly string[];
  readonly requires: readonly string[];
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

export const str = (description: string) => ({ type: "string", description });
export const int = (description: string) => ({ type: "integer", description });
export const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

export const RECALL = " Superseded and retired entries are excluded from recall (a v3 change: v3 still returned them).";
/** R18 D3 fix round: the V6 recall tools list through `listNodes`'s
 *  `eligible_only` view, #29's FULL rule, so they say so. */
export const RECALL_FULL = RECALL + " So are forgotten (is_active:false) entries and entries outside their validity window.";
export const NO_FILE = " Nothing is written to disk; LanceDB is canonical, so `file` is null.";
export const TAXONOMY_READS = ["lookupVocabularyByName", "lookupTermByName"];
export const TAXONOMY_WRITES = ["seedReservedVocabularies", "createVocabulary", "createTerm"];
export const PUBLISH = [...TAXONOMY_READS, ...TAXONOMY_WRITES, "getPeer", "registerPeer", "publishRevision", "indexRevisionChunks"];
export const PUBLISH_REQUIRES = [...TAXONOMY_READS, ...TAXONOMY_WRITES, "publishRevision", "indexRevisionChunks"];
/**
 * K1, the #30 knowledge searches, under the names #30 SHIPPED them with
 * (search-chunk-v1.md §13). V3-PARITY.md §5 designed them as
 * `searchChunksKeyword`/`searchChunksSemantic`; those names never existed,
 * so rule (c) kept every tool that required them hidden.
 */
export const KEYWORD = "searchKnowledgeKeyword";
export const SEMANTIC = "searchKnowledgeSemantic";
/** How a recall tool's `score` is made; the kernel's own value is not v3's. */
export const SCORE = " score is 1/(1+rank) in v4's order, not v3's fused relevance.";
/** The forum writes (V4): speaker, session, membership, post, reopen link. */
export const FORUM_WRITE = ["getPeer", "registerPeer", "getSession", "registerSession", "joinSession", "appendMessages", "createSessionLink"];

export const spec = (s: V3ToolSpec): V3ToolSpec =>
  Object.freeze({
    ...s,
    ...(s.alsoNeeds === undefined ? {} : { alsoNeeds: Object.freeze([...s.alsoNeeds]) }),
    uses: Object.freeze([...s.uses]),
    requires: Object.freeze([...s.requires]),
  });
