import { getAcceptedHead } from "./service.getAcceptedHead";
import { listAcceptedHistory } from "./service.listAcceptedHistory";
import { listNodes } from "./service.listNodes";
import { type DatasetAdapter, type PublicationReaderService } from "./service.types";

export function makeReadMethods(reader: DatasetAdapter): PublicationReaderService {
  return {
    getAcceptedHead: (requestBytes: Uint8Array) => getAcceptedHead(reader, requestBytes),
    listAcceptedHistory: (requestBytes: Uint8Array) => listAcceptedHistory(reader, requestBytes),
    // `requestTimeMs`: the transport's request time, read only by the
    // `eligible_only` recall view (R18 D3; see `service.listNodes.ts`).
    listNodes: (requestBytes: Uint8Array, requestTimeMs?: number) => listNodes(reader, requestBytes, requestTimeMs),
  };
}
