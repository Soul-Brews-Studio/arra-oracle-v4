import type { ChatModelInput } from "./publication/chat";

const SYSTEM = [
  "You answer questions using only the recorded evidence you are given.",
  "The evidence is what was written down in this workspace. It is recorded understanding,",
  "not a live agent: nobody is contacted by this question.",
  "Each evidence line starts with its id in square brackets. Cite the id of every line you rely on,",
  "in square brackets, for example [abc123].",
  "If the evidence does not answer the question, say so plainly instead of guessing.",
  "Answer in your own words, in one to three sentences; do not copy the evidence lines out verbatim.",
].join(" ");

/**
 * The prompt one model call sends: fixed instructions, then the evidence,
 * then the question. PURE string assembly.
 *
 * Built from `input.items` -- the context items `getContext` already
 * authorized -- and nothing else, so what reaches the model is exactly what
 * the asking peer may read. `context_text` (chat.ts `renderContextText`) is
 * not used because it carries no ids, and a model cannot cite what it was
 * never shown.
 *
 * A continuation line of a multi-line message is indented, so a line that
 * starts with `[` is always a real evidence id, never text inside a message
 * pretending to be one.
 */
export function renderChatPrompt(input: ChatModelInput): { system: string; user: string } {
  const evidence =
    input.items.length === 0
      ? "(no evidence)"
      : input.items
          .map((item) => `[${item.public_id}] ${item.session_name} / ${item.peer_name}: ${item.content.replace(/\n/g, "\n    ")}`)
          .join("\n");
  // The language instruction sits beside the question, where a small local
  // model actually follows it (measured on gemma3:4b: in the system prompt
  // alone, a Thai question was answered in English).
  return {
    system: SYSTEM,
    user: `Evidence:\n${evidence}\n\nAnswer in the same language as this question.\nQuestion: ${input.question}`,
  };
}
