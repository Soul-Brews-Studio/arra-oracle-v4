import { getContext } from "./service.getContext";
import { getMessage } from "./service.getMessage";
import { getPeer } from "./service.getPeer";
import { getReadCursor } from "./service.getReadCursor";
import { getRecallEligibility } from "./service.getRecallEligibility";
import { getSession } from "./service.getSession";
import { getTrace } from "./service.getTrace";
import { listLifecycleHistory } from "./service.listLifecycleHistory";
import { listMessages } from "./service.listMessages";
import { listPeers } from "./service.listPeers";
import { listSearchChunks } from "./service.listSearchChunks";
import { listSessions } from "./service.listSessions";
import { listSessionLinks } from "./service.listSessionLinks";
import { listTraceHits } from "./service.listTraceHits";
import { type DatasetAdapter } from "./service.types";

export function createContextReadMethods(reader: DatasetAdapter) {
  return {
    getPeer: (requestBytes: Uint8Array) => getPeer(reader, requestBytes),
    getSession: (requestBytes: Uint8Array) => getSession(reader, requestBytes),
    getMessage: (requestBytes: Uint8Array) => getMessage(reader, requestBytes),
    listMessages: (requestBytes: Uint8Array) => listMessages(reader, requestBytes),
    listPeers: (requestBytes: Uint8Array) => listPeers(reader, requestBytes),
    listSessions: (requestBytes: Uint8Array) => listSessions(reader, requestBytes),
    getReadCursor: (requestBytes: Uint8Array) => getReadCursor(reader, requestBytes),
    listSessionLinks: (requestBytes: Uint8Array) => listSessionLinks(reader, requestBytes),
    getRecallEligibility: (requestBytes: Uint8Array) => getRecallEligibility(reader, requestBytes),
    listLifecycleHistory: (requestBytes: Uint8Array) => listLifecycleHistory(reader, requestBytes),
    getTrace: (requestBytes: Uint8Array) => getTrace(reader, requestBytes),
    listTraceHits: (requestBytes: Uint8Array) => listTraceHits(reader, requestBytes),
    listSearchChunks: (requestBytes: Uint8Array) => listSearchChunks(reader, requestBytes),
    getContext: (requestBytes: Uint8Array) => getContext(reader, requestBytes),
  };
}
