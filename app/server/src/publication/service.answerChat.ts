import { type AnswerChatResult, type ChatModelFn, mapModelFailure, parseAnswerChat, renderContextText } from "./chat";
import { type ChatReader } from "./service.types";

/**
 * Evidence-grounded chat (#32): compose the requester's context, then ask the
 * model. A READ -- it persists nothing, so it runs on the reader facade and
 * never opens, holds or releases a writer (#32 slice A, overnight ruling R9).
 *
 * `model` absent means unconfigured: `model_unavailable` before any dataset
 * read, so an unconfigured server spends nothing on a question it cannot
 * answer. Any model throw maps to the same code (`mapModelFailure`).
 */
export function answerChat(reader: ChatReader, model: ChatModelFn | undefined, requestBytes: Uint8Array): Promise<AnswerChatResult> {
  // STATIC validation precedes any retrieval, the same discipline every
  // other request parse follows.
  const request = parseAnswerChat(requestBytes);
  return (async () => {
    if (model === undefined) return mapModelFailure();
    const contextBytes = new TextEncoder().encode(
      JSON.stringify({
        workspace_name: request.workspace_name,
        peer_name: request.peer_name,
        session_name: request.session_name,
        max_items: request.max_items,
      }),
    );
    const contextResult = await reader.getContext(contextBytes);
    // ONLY `items` crosses into the model: every one of them passed the
    // per-session membership check. `excluded` is never rendered or
    // passed, and it no longer identifies unauthorized items anyway (#85).
    const contextText = renderContextText(contextResult.items);
    let answer: string;
    try {
      answer = await model({ question: request.question, context_text: contextText, items: contextResult.items });
    } catch {
      return mapModelFailure();
    }
    return {
      answer,
      coverage: contextResult.coverage,
      excluded: contextResult.excluded,
      excluded_omitted: contextResult.excluded_omitted,
      items_used: contextResult.items.map((item) => item.public_id),
    };
  })();
}
