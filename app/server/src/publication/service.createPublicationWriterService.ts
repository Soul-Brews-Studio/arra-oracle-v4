import { makeReadMethods } from "./service.makeReadMethods";
import { publishRevision } from "./service.publishRevision";
import { type Clock, type DatasetAdapter, type IdSource, type OwnerCore, type PublicationWriterService } from "./service.types";

export function createPublicationWriterService(
  writer: DatasetAdapter,
  options: { clock: Clock; newRevisionId: IdSource },
  core: OwnerCore,
): PublicationWriterService {
  const reads = makeReadMethods(writer);
  return Object.freeze({
    ...reads,
    publishRevision: (requestBytes: Uint8Array) => publishRevision(writer, options, core, requestBytes),
    close: core.close,
  });
}
