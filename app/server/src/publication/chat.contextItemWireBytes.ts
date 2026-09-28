// Split from chat.ts (style-split4b, 2026-09-28).
import type { ChatContextItem } from "./chat.state";

/** One wire-byte measurement, matching `context.ts`'s own `rowWireBytes`
 *  convention (JSON text, UTF-8 bytes) but over the REDUCED chat shape. */
export function contextItemWireBytes(item: ChatContextItem): number {
  return new TextEncoder().encode(JSON.stringify(item)).length;
}
