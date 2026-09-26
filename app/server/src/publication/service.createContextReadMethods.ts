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
import { type RequestAuthority } from "./context";
import { type DatasetAdapter } from "./service.types";

export function createContextReadMethods(reader: DatasetAdapter) {
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
    // #29 slice B: `requestTimeMs` is the validity-window `as_of`, supplied
    // by the transport (`knowledge/registry.ts`) as real request time --
    // see `service.getRecallEligibility.ts` for why it stays optional here.
    getRecallEligibility: (requestBytes: Uint8Array, requestTimeMs?: number) =>
      getRecallEligibility(reader, requestBytes, requestTimeMs),
    listLifecycleHistory: (requestBytes: Uint8Array) => listLifecycleHistory(reader, requestBytes),
    getTrace: (requestBytes: Uint8Array) => getTrace(reader, requestBytes),
    listTraceHits: (requestBytes: Uint8Array) => listTraceHits(reader, requestBytes),
    listSearchChunks: (requestBytes: Uint8Array) => listSearchChunks(reader, requestBytes),
    getContext: (requestBytes: Uint8Array) => getContext(reader, requestBytes),
    listMcpCalls: (requestBytes: Uint8Array) => listMcpCalls(reader, requestBytes),
    listConnections: (requestBytes: Uint8Array) => listConnections(reader, requestBytes),
  };
}
