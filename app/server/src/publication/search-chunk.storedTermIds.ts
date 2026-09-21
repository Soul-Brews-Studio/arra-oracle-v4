import { failPublication } from "./errors";
import { storedText } from "./search-chunk.storedText";

/**
 * `term_ids` is `list<utf8?> NOT NULL` -- the only list-typed column in the
 * whole schema. The list itself is required; each ELEMENT is nullable by the
 * physical type, though this writer never stores a null element.
 *
 * Accepts either a real JS array (the shape `decodeArrowRows` would need to
 * hand back for this to round-trip transparently) or an Arrow-list-like
 * object exposing `toArray()`, so the codec does not assume which one the
 * measured decode path actually produces.
 */
export function storedTermIds(value: unknown): (string | null)[] {
  let items: unknown;
  if (Array.isArray(value)) {
    items = value;
  } else if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toArray?: unknown }).toArray === "function"
  ) {
    items = (value as { toArray(): unknown }).toArray();
  } else {
    return failPublication("integrity_failure", "");
  }
  if (!Array.isArray(items)) failPublication("integrity_failure", "");
  return items.map((item) => {
    // EXPLICIT null only -- see `storedNullableTimestamp`.
    if (item === null) return null;
    return storedText(item);
  });
}
