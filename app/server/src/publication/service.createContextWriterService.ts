import { type ChatModelFn } from "./chat";
import { advanceReadCursor } from "./service.advanceReadCursor";
import { answerChat } from "./service.answerChat";
import { appendMessages } from "./service.appendMessages";
import { createContextReadMethods } from "./service.createContextReadMethods";
import { createSessionLink } from "./service.createSessionLink";
import { createTrace } from "./service.createTrace";
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
  options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn },
) {
  const reads = createContextReadMethods(writer);
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
    registerPeer: (requestBytes: Uint8Array) => registerPeer(writer, core, options, requestBytes),
    registerSession: (requestBytes: Uint8Array) => registerSession(writer, core, options, requestBytes),
    joinSession: (requestBytes: Uint8Array) => joinSession(writer, core, options, requestBytes),
    appendMessages: (requestBytes: Uint8Array) => appendMessages(writer, core, options, requestBytes),
    answerChat: (requestBytes: Uint8Array) => answerChat(writer, core, options, requestBytes),
  };
}
