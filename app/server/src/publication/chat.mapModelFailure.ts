// Split from chat.ts (style-split4b, 2026-09-28).
import { failPublication } from "./errors";

/**
 * Map an absent or failed MODEL call onto the closed publication code set:
 * `model_unavailable` (#32, overnight ruling R9; chat-v1.md amendment).
 *
 * One code for every way a model can fail to produce an answer -- none
 * configured, unreachable, timed out, answered non-2xx, answered nothing --
 * because the caller acts on all of them the same way: nothing was read
 * wrongly, nothing was written, retry later or configure a model.
 *
 * It used to REUSE `writer_unavailable`, which made "no model", "model
 * failed" and "the dataset writer is busy" one indistinguishable 503 -- and
 * the writer case was a real, separate defect (#32 analysis) that the reuse
 * hid. A model failure is not a writer failure: `answerChat` no longer touches
 * a writer at all.
 */
export function mapModelFailure(): never {
  return failPublication("model_unavailable", "");
}
