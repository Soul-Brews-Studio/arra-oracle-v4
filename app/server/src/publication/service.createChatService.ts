import { type ChatModelFn, type ChatSettings } from "./chat";
import { answerChat } from "./service.answerChat";
import { getChatSettings } from "./service.getChatSettings";
import { type ChatReader } from "./service.types";

/**
 * The chat facade (#32 slice A, overnight ruling R9): built over a READER's
 * `getContext`, never a writer. The model and its settings are trusted
 * composition input (`composition.ts` -> `src/chat-model.ts`), never request
 * data, and they do not travel in writer options any more.
 *
 * Taking the reader's context facade rather than a dataset adapter keeps the
 * adapter private to this package and makes the boundary structural: this
 * service holds no method that could write.
 */
export function createChatService(reader: ChatReader, options: { model?: ChatModelFn; settings: ChatSettings | null }) {
  return Object.freeze({
    answerChat: (requestBytes: Uint8Array) => answerChat(reader, options.model, requestBytes),
    getChatSettings: (requestBytes: Uint8Array) => getChatSettings(options.settings, requestBytes),
  });
}
