/** The knowledge registry, mirrored for the UI.
 *
 * Source of truth is `app/server/src/knowledge/registry.ts` -- 44 methods as
 * of the #31 overnight R7/R8 exposure (docs/overnight/DECISIONS.md).
 * This file is a DISPLAY copy: it drives the picker and nothing else. If the
 * server registry changes, this list goes stale silently, so it is deliberately
 * small and flat rather than trying to be clever about staying in sync.
 *
 * The session-link, trace, lifecycle and search-chunk kernels (previously
 * excluded here, matching the server's own now-superseded exclusion) are
 * listed below under `tier: "context"`, the same facade grouping
 * `knowledge/registry.ts` uses for them.
 *
 * Pre-existing drift, NOT touched by the #31 overnight exposure amendment
 * above (out of scope for R7/R8; disclosed rather than silently left):
 * `listPeers`, `listSessions`, `listMcpCalls` and `listConnections` were
 * already missing from this mirror before this change, even though they
 * were already registry entries.
 */
export type Action = "content:read" | "content:write";

export type Method = {
  name: string;
  action: Action;
  tier: "publication" | "taxonomy" | "context" | "evidence";
};

export const METHODS: Method[] = [
  { name: "getAcceptedHead", action: "content:read", tier: "publication" },
  { name: "listAcceptedHistory", action: "content:read", tier: "publication" },
  { name: "publishRevision", action: "content:write", tier: "publication" },

  { name: "getVocabulary", action: "content:read", tier: "taxonomy" },
  { name: "getTerm", action: "content:read", tier: "taxonomy" },
  { name: "createVocabulary", action: "content:write", tier: "taxonomy" },
  { name: "createTerm", action: "content:write", tier: "taxonomy" },
  { name: "renameTerm", action: "content:write", tier: "taxonomy" },
  { name: "retireTerm", action: "content:write", tier: "taxonomy" },
  { name: "reparentTerm", action: "content:write", tier: "taxonomy" },
  { name: "seedReservedVocabularies", action: "content:write", tier: "taxonomy" },

  { name: "getPeer", action: "content:read", tier: "context" },
  { name: "getSession", action: "content:read", tier: "context" },
  { name: "getMessage", action: "content:read", tier: "context" },
  { name: "listMessages", action: "content:read", tier: "context" },
  { name: "getReadCursor", action: "content:read", tier: "context" },
  { name: "getContext", action: "content:read", tier: "context" },
  { name: "registerPeer", action: "content:write", tier: "context" },
  { name: "registerSession", action: "content:write", tier: "context" },
  { name: "joinSession", action: "content:write", tier: "context" },
  { name: "appendMessages", action: "content:write", tier: "context" },
  { name: "advanceReadCursor", action: "content:write", tier: "context" },
  { name: "answerChat", action: "content:write", tier: "context" },

  // #28/#29/#30 kernels, exposed by the #31 overnight R7/R8 slice.
  { name: "listSessionLinks", action: "content:read", tier: "context" },
  { name: "createSessionLink", action: "content:write", tier: "context" },
  { name: "getTrace", action: "content:read", tier: "context" },
  { name: "listTraceHits", action: "content:read", tier: "context" },
  { name: "createTrace", action: "content:write", tier: "context" },
  { name: "getRecallEligibility", action: "content:read", tier: "context" },
  { name: "listLifecycleHistory", action: "content:read", tier: "context" },
  { name: "retireNode", action: "content:write", tier: "context" },
  { name: "supersedeNode", action: "content:write", tier: "context" },
  { name: "listSearchChunks", action: "content:read", tier: "context" },
  { name: "indexRevisionChunks", action: "content:write", tier: "context" },
  { name: "writeChunkEmbedding", action: "content:write", tier: "context" },
  { name: "reconcileSearchChunks", action: "content:write", tier: "context" },

  { name: "getRevisionAssociations", action: "content:read", tier: "evidence" },
  { name: "scanDependents", action: "content:read", tier: "evidence" },
  { name: "reconcileRevisionAssociations", action: "content:write", tier: "evidence" },
];

export const TIERS = ["publication", "taxonomy", "context", "evidence"] as const;
