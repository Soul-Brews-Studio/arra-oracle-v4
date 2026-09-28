// Split from chat.ts (style-split4b, 2026-09-28).
import type { JcsObject } from "../contracts/jcs";
import { name } from "./chat.name";
import { AUTHOR_KEYS, PERSPECTIVE_KEYS } from "./chat.state";

/** An optional perspective name: absent or null is "any", else the same
 *  name grammar as every other peer name here. */
export function perspective(o: JcsObject, key: (typeof PERSPECTIVE_KEYS)[number] | (typeof AUTHOR_KEYS)[number]): string | null {
  const value = o.get(key);
  return value === undefined || value === null ? null : name(value, [key]);
}
