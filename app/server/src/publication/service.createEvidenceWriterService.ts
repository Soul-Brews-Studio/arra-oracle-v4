import { createEvidenceReadMethods } from "./service.createEvidenceReadMethods";
import { reconcileRevisionAssociations } from "./service.reconcileRevisionAssociations";
import { type DatasetAdapter, type OwnerCore } from "./service.types";

export function createEvidenceWriterService(writer: DatasetAdapter, core: OwnerCore) {
  const reads = createEvidenceReadMethods(writer);
  return {
    ...reads,

    reconcileRevisionAssociations: (requestBytes: Uint8Array) => reconcileRevisionAssociations(writer, core, requestBytes),
  };
}
