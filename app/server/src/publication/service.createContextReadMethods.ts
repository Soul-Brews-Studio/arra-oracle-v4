import { getContext } from "./service.getContext";
import { getMessage } from "./service.getMessage";
import { getPeer } from "./service.getPeer";
import { getReadCursor } from "./service.getReadCursor";
import { getRecallEligibility } from "./service.getRecallEligibility";
import { getSession } from "./service.getSession";
import { getTrace } from "./service.getTrace";
import { listConnections } from "./service.listConnections";
import { listLifecycleHistory } from "./service.listLifecycleHistory";
import { listMcpCalls } from "./service.listMcpCalls";
import { listMessages } from "./service.listMessages";
import { listPeers } from "./service.listPeers";
import { listSearchChunks } from "./service.listSearchChunks";
import { listSessions } from "./service.listSessions";
import { listSessionLinks } from "./service.listSessionLinks";
import { listTraceHits } from "./service.listTraceHits";
import { searchKnowledgeKeyword } from "./service.searchKnowledgeKeyword";
import { searchKnowledgeSemantic } from "./service.searchKnowledgeSemantic";
import { type RequestAuthority } from "./context";
import { type DatasetAdapter, type QueryEmbedder } from "./service.types";

/** `embedder` is trusted composition, never request data (see `QueryEmbedder`). */
export function createContextReadMethods(reader: DatasetAdapter, options: { embedder?: QueryEmbedder } = {}) {
  return {
    getPeer: (requestBytes: Uint8Array) => getPeer(reader, requestBytes),
    getSession: (requestBytes: Uint8Array) => getSession(reader, requestBytes),
    // #87 / R3: the two message reads also take the transport-built authority.
    getMessage: (requestBytes: Uint8Array, authority: RequestAuthority) => getMessage(reader, requestBytes, authority),
    listMessages: (requestBytes: Uint8Array, authority: RequestAuthority) => listMessages(reader, requestBytes, authority),
    listPeers: (requestBytes: Uint8Array) => listPeers(reader, requestBytes),
    listSessions: (requestBytes: Uint8Array) => listSessions(reader, requestBytes),
    getReadCursor: (requestBytes: Uint8Array) => getReadCursor(reader, requestBytes),
    listSessionLinks: (requestBytes: Uint8Array) => listSessionLinks(reader, requestBytes),
    getRecallEligibility: (requestBytes: Uint8Array) => getRecallEligibility(reader, requestBytes),
    listLifecycleHistory: (requestBytes: Uint8Array) => listLifecycleHistory(reader, requestBytes),
    getTrace: (requestBytes: Uint8Array) => getTrace(reader, requestBytes),
    listTraceHits: (requestBytes: Uint8Array) => listTraceHits(reader, requestBytes),
    listSearchChunks: (requestBytes: Uint8Array) => listSearchChunks(reader, requestBytes),
    // #30 retrieval (overnight R7 #30 part + R14): two separate methods, never fused.
    searchKnowledgeKeyword: (requestBytes: Uint8Array) => searchKnowledgeKeyword(reader, requestBytes),
    searchKnowledgeSemantic: (requestBytes: Uint8Array) => searchKnowledgeSemantic(reader, options.embedder, requestBytes),
    getContext: (requestBytes: Uint8Array) => getContext(reader, requestBytes),
    listMcpCalls: (requestBytes: Uint8Array) => listMcpCalls(reader, requestBytes),
    listConnections: (requestBytes: Uint8Array) => listConnections(reader, requestBytes),
  };
}
