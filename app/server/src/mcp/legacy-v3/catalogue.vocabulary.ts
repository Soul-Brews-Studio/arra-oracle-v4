/**
 * Description fragments and method-name groups the `catalogue.ts` entries
 * reuse. DATA ONLY -- no behaviour. Kept as one file (like
 * `readerOnlyMethods.ts`'s single-export precedent, but grouped): these are
 * plain string/array literals, not functions, so Nat's "one exported
 * function per file" rule does not bind them individually. Recorded as the
 * kind of multi-export debt PLAN.md's 03:16 style audit already tracks
 * (12 of 561 files, the worst one under server/src/contracts/ at 19
 * exports) rather than atomized into 11 one-line files under this slice's
 * time box.
 */

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
