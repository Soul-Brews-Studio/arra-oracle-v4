/**
 * Caller-asserted peer fields per knowledge method (#87 / R3,
 * docs/overnight/DECISIONS.md) -- data only, beside `registry.ts`.
 *
 * Each path names one request field in which the CALLER asserts which peer is
 * acting: the requester of a read or of chat context, the reader of a cursor,
 * the peer joining a session, the author of a message, the author or observer
 * of a revision. `"*"` walks every element of an array.
 *
 * When the grant that admitted a request carries an arra-auth/v1 `peers`
 * binding, both transports refuse -- 403, `forbidden`, at the offending
 * field's JSON pointer -- any string found at these paths that the binding
 * does not list, BEFORE a writer is opened or a kernel runs. With no binding,
 * nothing here is consulted and behaviour is exactly as before.
 *
 * Deliberately NOT listed: lookup targets (`getPeer.peer_name`,
 * `registerPeer.name`) and a revision's `subject_peer_name`. Naming a peer, or
 * writing ABOUT one, is not acting as it.
 *
 * EXHAUSTIVE over `KNOWLEDGE_METHODS`: every registered method appears, and
 * `[]` is a reviewed "asserts no peer". A method added to the registry later
 * (e.g. #28's `created_by_peer_name`, a lifecycle or trace `peer_name`) must
 * be classified here too -- `transport-peer-fields.test.ts` fails until it
 * is, and until then a bound grant is refused that method outright
 * (`transport.requireBoundPeers.ts`), never let through unchecked.
 */

export type PeerFieldPath = readonly string[];

export const PEER_FIELDS: Readonly<Record<string, readonly PeerFieldPath[]>> = Object.freeze({
  // requester (message reads; the kernel re-checks this one itself)
  getMessage: [["requester_peer_name"]],
  listMessages: [["requester_peer_name"]],
  // K10: the member list is read AS a member, on the message reads' terms
  listSessionMembers: [["requester_peer_name"]],
  // requester of chat context
  getContext: [["peer_name"]],
  answerChat: [["peer_name"]],
  // the reader whose cursor it is
  getReadCursor: [["peer_name"]],
  advanceReadCursor: [["peer_name"]],
  // the peer joining
  joinSession: [["peer_name"]],
  // author of each message
  appendMessages: [["items", "*", "message", "peer_name"]],
  // author and observer of a revision (subject excluded, see above)
  publishRevision: [
    ["content", "author_peer_name"],
    ["content", "observer_peer_name"],
  ],
  // actor of a trace, a session link, or a lifecycle event (#28 / #29, exposed
  // by the expose-13 slice; classified at the overnight merge, which is what
  // the exhaustiveness test below exists to force)
  createTrace: [["peer_name"]],
  createSessionLink: [["created_by_peer_name"]],
  // the peer closing a session (K9, overnight R18 D7; the kernel re-checks it)
  closeSession: [["peer_name"]],
  // K10: "sessions X belongs to" is asked AS X -- a bound credential may ask
  // only about its own peers, the same rule as a message requester.
  listSessions: [["member_peer_name"]],
  retireNode: [["peer_name"]],
  supersedeNode: [["peer_name"]],
  // reviewed: these assert no acting peer (lookups, taxonomy, evidence, audit)
  getTrace: [],
  listTraceHits: [],
  // K5 (#31 overnight R18): a filtered listing, names no acting peer.
  listTraces: [],
  listSessionLinks: [],
  getRecallEligibility: [],
  listLifecycleHistory: [],
  indexRevisionChunks: [],
  reconcileSearchChunks: [],
  listSearchChunks: [],
  writeChunkEmbedding: [],
  getAcceptedHead: [],
  listAcceptedHistory: [],
  listNodes: [],
  getVocabulary: [],
  getTerm: [],
  lookupVocabularyByName: [],
  lookupTermByName: [],
  // K6+K7 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 (K6+K7+V8)):
  // term listing, term usage counts and knowledge stats assert no acting peer.
  listTerms: [],
  listTermUsage: [],
  knowledgeStats: [],
  createVocabulary: [],
  createTerm: [],
  renameTerm: [],
  retireTerm: [],
  reparentTerm: [],
  seedReservedVocabularies: [],
  getPeer: [],
  getSession: [],
  listPeers: [],
  registerPeer: [],
  registerSession: [],
  listMcpCalls: [],
  listConnections: [],
  // #32 / R9: process configuration, names no peer at all.
  getChatSettings: [],
  getRevisionAssociations: [],
  scanDependents: [],
  reconcileRevisionAssociations: [],
  // #30 retrieval: a query names no acting peer.
  searchKnowledgeKeyword: [],
  searchKnowledgeSemantic: [],
  // #30 R7/R8 (search-embed): freshness and the embed worker take
  // workspace_name plus limit fields only -- no peer-shaped field. The other
  // four search-chunk methods are classified above.
  getSearchFreshness: [],
  embedPendingChunks: [],
});
