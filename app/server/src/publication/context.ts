/**
 * Context request grammar and physical row encoding.
 *
 * PURE by contract. No SDK import, and nothing here acquires, retains or
 * returns a connection, table, adapter or owner. Persistence stays private in
 * service.ts, so this module can be exercised without a dataset and cannot
 * become a back door to one.
 *
 * TWO envelopes, deliberately, and neither is new:
 *   - governed ContractError / arra-error/v1 for parse, shape and value. Those
 *     come from the shared `contracts/common` helpers, so RFC 6901 escaping and
 *     deterministic unknown-key ordering are inherited rather than reimplemented.
 *   - PublicationError / arra-publication-error/v1 for STORED-state failures.
 *     The historical version name is deliberate reuse; it is not a claim that
 *     this module publishes knowledge.
 *
 * Contract: app/docs/contracts/context-ingestion-v1.md
 *
 * THIN BARREL: this file is now only a re-export surface. The implementation
 * lives one function per file, each named `context.<functionName>.ts` beside
 * this barrel -- see those files for the request grammar, stored-row codec,
 * and their private helpers.
 */

export { MAX_ITEMS, type AppendItem, type AppendMessagesRequest, parseAppendMessages } from "./context.parseAppendMessages";
export { MAX_RESULT_WIRE_BYTES } from "./context.constants";
export { MAX_PAGE_LIMIT, type ListMessagesRequest, parseListMessages } from "./context.parseListMessages";
export { type ListPeersRequest, parseListPeers } from "./context.parseListPeers";
export { type ListSessionsRequest, parseListSessions } from "./context.parseListSessions";
export { PEER_FIELDS, encodePeerRow } from "./context.encodePeerRow";
export { SESSION_FIELDS, encodeSessionRow } from "./context.encodeSessionRow";
export { SESSION_PEER_FIELDS, encodeSessionPeerRow } from "./context.encodeSessionPeerRow";
export { MESSAGE_FIELDS, encodeMessageRow } from "./context.encodeMessageRow";
export { type RegisterPeerRequest, parseRegisterPeer } from "./context.parseRegisterPeer";
export { type RegisterSessionRequest, parseRegisterSession } from "./context.parseRegisterSession";
export { type JoinSessionRequest, parseJoinSession } from "./context.parseJoinSession";
export { type GetPeerRequest, parseGetPeer } from "./context.parseGetPeer";
export { type GetSessionRequest, parseGetSession } from "./context.parseGetSession";
export { type GetMessageRequest, parseGetMessage } from "./context.parseGetMessage";
export { rowWireBytes } from "./context.rowWireBytes";
