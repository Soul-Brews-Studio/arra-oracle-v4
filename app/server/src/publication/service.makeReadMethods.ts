import { getAcceptedHead } from "./service.getAcceptedHead";
import { listAcceptedHistory } from "./service.listAcceptedHistory";
import { type DatasetAdapter, type PublicationReaderService } from "./service.types";

export function makeReadMethods(reader: DatasetAdapter): PublicationReaderService {
  return {
    getAcceptedHead: (requestBytes: Uint8Array) => getAcceptedHead(reader, requestBytes),
    listAcceptedHistory: (requestBytes: Uint8Array) => listAcceptedHistory(reader, requestBytes),
  };
}
