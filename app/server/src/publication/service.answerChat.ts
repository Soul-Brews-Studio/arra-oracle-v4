import { type ChatModelFn, mapModelFailure, parseAnswerChat, renderContextText } from "./chat";
import { getContext } from "./service.getContext";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export function answerChat(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array) {
const model: ChatModelFn = options.model ?? (() => mapModelFailure());

// STATIC validation precedes any retrieval, the same discipline every
      // other mutation's request parse follows.
      const request = parseAnswerChat(requestBytes);
      return (async () => {
        const contextBytes = new TextEncoder().encode(
          JSON.stringify({
            workspace_name: request.workspace_name,
            peer_name: request.peer_name,
            session_name: request.session_name,
            max_items: request.max_items,
          }),
        );
        const contextResult = await getContext(writer, contextBytes);
        // ONLY `items` crosses into the model: every one of them passed the
        // per-session membership check. `excluded` is never rendered or
        // passed, and it no longer identifies unauthorized items anyway (#85).
        const contextText = renderContextText(contextResult.items);
        let answer: string;
        try {
          answer = await model({ question: request.question, context_text: contextText, items: contextResult.items });
        } catch {
          // Neither existing envelope fits a MODEL failure; see chat.ts's
          // `mapModelFailure` for the documented mapping decision.
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
