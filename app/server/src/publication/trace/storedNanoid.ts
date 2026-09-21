import { failPublication } from "../errors";
import { storedNonemptyText } from "./storedNonemptyText";

const NANOID21_PATTERN = /^[A-Za-z0-9_-]{21}$/;

/**
 * A stored nanoid21, required. The request grammar requires nanoid21 for
 * `id`/`parent_id`/`prev_id`/`trace_id` (`requireNanoid21`, `nullablePointer`
 * above); a stored value that does not satisfy the same namespace is state
 * this service could never have written. Mirrors `read-cursor.ts`'s
 * `storedPointer`: "A retained pointer must itself satisfy the declared
 * namespace. A malformed one is terminal through this interface rather than
 * silently converted."
 */
export function storedNanoid(value: unknown): string {
  const text = storedNonemptyText(value);
  if (!NANOID21_PATTERN.test(text)) failPublication("integrity_failure", "");
  return text;
}
