import { makeReadMethods } from "./service.makeReadMethods";
import { type DatasetAdapter, type PublicationReaderService } from "./service.types";

export function createPublicationReaderService(reader: DatasetAdapter): PublicationReaderService {
  return Object.freeze(makeReadMethods(reader));
}
