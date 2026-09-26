import { type DigestProbeFn, type EmbedFn } from "./search-chunk.types";
import { advanceReadCursor } from "./service.advanceReadCursor";
import { appendMessages } from "./service.appendMessages";
import { createContextReadMethods } from "./service.createContextReadMethods";
import { createSessionLink } from "./service.createSessionLink";
import { createTrace } from "./service.createTrace";
import { embedPendingChunks } from "./service.embedPendingChunks";
import { indexRevisionChunks } from "./service.indexRevisionChunks";
import { joinSession } from "./service.joinSession";
import { reconcileSearchChunks } from "./service.reconcileSearchChunks";
import { registerPeer } from "./service.registerPeer";
import { registerSession } from "./service.registerSession";
import { retireNode } from "./service.retireNode";
import { supersedeNode } from "./service.supersedeNode";
import { writeChunkEmbedding } from "./service.writeChunkEmbedding";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export function createContextWriterService(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: {
    clock: Clock;
    sourceNamespace: string | null;
    /** #30 R8: the embed worker's DOCUMENT embedder (`embedPendingChunks`).
     *  A writer option because that method writes vectors; distinct from the
     *  reader-only query embedder semantic search uses. No chat model here
     *  (#32 / R9). */
    documentEmbedder?: EmbedFn;
    digestProbe?: DigestProbeFn;
    /** Canonical dataset root, for R20's pin file (`embedPendingChunks`,
     *  `getSearchFreshness`). */
    datasetRoot: string;
  },
) {
  const reads = createContextReadMethods(writer, options.datasetRoot);
  return {
    ...reads,

    advanceReadCursor: (requestBytes: Uint8Array) => advanceReadCursor(writer, core, options, requestBytes),
    createSessionLink: (requestBytes: Uint8Array) => createSessionLink(writer, core, options, requestBytes),
    createTrace: (requestBytes: Uint8Array) => createTrace(writer, core, options, requestBytes),
    retireNode: (requestBytes: Uint8Array) => retireNode(writer, core, options, requestBytes),
    supersedeNode: (requestBytes: Uint8Array) => supersedeNode(writer, core, options, requestBytes),
    indexRevisionChunks: (requestBytes: Uint8Array) => indexRevisionChunks(writer, core, options, requestBytes),
    writeChunkEmbedding: (requestBytes: Uint8Array) => writeChunkEmbedding(writer, core, options, requestBytes),
    reconcileSearchChunks: (requestBytes: Uint8Array) => reconcileSearchChunks(writer, core, options, requestBytes),
    embedPendingChunks: (requestBytes: Uint8Array) => embedPendingChunks(writer, core, options, requestBytes),
    registerPeer: (requestBytes: Uint8Array) => registerPeer(writer, core, options, requestBytes),
    registerSession: (requestBytes: Uint8Array) => registerSession(writer, core, options, requestBytes),
    joinSession: (requestBytes: Uint8Array) => joinSession(writer, core, options, requestBytes),
    appendMessages: (requestBytes: Uint8Array) => appendMessages(writer, core, options, requestBytes),
    // No `answerChat` here any more (#32 slice A, R9): it persists nothing, so
    // it is composed over the READER (service.createChatService.ts) and never
    // needs, holds or releases this writer.
    // No `searchKnowledgeKeyword`/`searchKnowledgeSemantic` either (#30), for
    // the same reason: they are READER-only (service.createSearchService.ts),
    // and the query embedder is never a writer option. What the writer keeps
    // is the keyword index MAINTENANCE, inside `indexRevisionChunks`.
  };
}
