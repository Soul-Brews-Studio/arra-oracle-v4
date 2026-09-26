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
 * writing ABOUT one, is not acting as it. A method added to the registry later
 * that carries an acting-peer field (e.g. #28's `created_by_peer_name`) must
 * be added here too; absence means "asserts no peer", not "exempt".
 */

export type PeerFieldPath = readonly string[];

export const PEER_FIELDS: Readonly<Record<string, readonly PeerFieldPath[]>> = Object.freeze({
  // requester (message reads; the kernel re-checks this one itself)
  getMessage: [["requester_peer_name"]],
  listMessages: [["requester_peer_name"]],
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
});
