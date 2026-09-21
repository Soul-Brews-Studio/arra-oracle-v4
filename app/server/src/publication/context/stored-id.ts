import { failPublication } from "../errors";
import { storedText } from "./stored-text";

const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

/** A stored identifier must satisfy the nanoid21 grammar, not merely be a string. */
export function storedId(value: unknown): string {
  const text = storedText(value);
  if (!NANOID21.test(text)) failPublication("integrity_failure");
  return text;
}
