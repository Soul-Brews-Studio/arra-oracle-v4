// Split from chat.ts (style-split4b, 2026-09-28).
import type { ChatContextItem, ConclusionItem } from "./chat.state";

/**
 * Deterministic transcript rendering for the model prompt.
 *
 * PURE string assembly only. This text is what eventually crosses into the
 * injected model call (service.ts), but building it is not itself a model
 * call, and this function never invokes one.
 */
export function renderContextText(items: ChatContextItem[], conclusions: ConclusionItem[] = []): string {
  const messages = items.map((item) => `[${item.session_name}] ${item.peer_name}: ${item.content}`);
  // D3b: conclusions render with their revision id, so a model can cite it.
  const views = conclusions.map(
    (c) => `[conclusion ${c.revision_id}] ${c.observer_peer_name ?? "any"} -> ${c.subject_peer_name ?? "any"}: ${c.text}`,
  );
  return [...views, ...messages].join("\n");
}
