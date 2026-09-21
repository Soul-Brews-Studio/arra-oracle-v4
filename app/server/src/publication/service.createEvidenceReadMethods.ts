import { getRevisionAssociations } from "./service.getRevisionAssociations";
import { scanDependents } from "./service.scanDependents";
import { type DatasetAdapter } from "./service.types";

export function createEvidenceReadMethods(reader: DatasetAdapter) {
  return {
    getRevisionAssociations: (requestBytes: Uint8Array) => getRevisionAssociations(reader, requestBytes),
    scanDependents: (requestBytes: Uint8Array) => scanDependents(reader, requestBytes),
  };
}
