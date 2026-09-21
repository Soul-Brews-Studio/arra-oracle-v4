/** The knowledge registry, mirrored for the UI.
 *
 * Source of truth is `app/server/src/knowledge/registry.ts` -- 26 methods.
 * This file is a DISPLAY copy: it drives the picker and nothing else. If the
 * server registry changes, this list goes stale silently, so it is deliberately
 * small and flat rather than trying to be clever about staying in sync.
 *
 * Deliberately NOT here, matching the server's own exclusion: session-link,
 * lifecycle, trace and search-chunk kernels. They are wired in service.ts but
 * not exposed over the transport -- unreviewed write envelopes, and no
 * enumeration endpoint to browse them by.
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

  { name: "getRevisionAssociations", action: "content:read", tier: "evidence" },
  { name: "scanDependents", action: "content:read", tier: "evidence" },
  { name: "reconcileRevisionAssociations", action: "content:write", tier: "evidence" },
];

export const TIERS = ["publication", "taxonomy", "context", "evidence"] as const;
