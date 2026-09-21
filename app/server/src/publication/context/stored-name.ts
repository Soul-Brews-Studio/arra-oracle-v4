import { failPublication } from "../errors";
import { utf8ByteLength } from "../rows";
import { MAX_NAME_BYTES } from "./constants";
import { storedText } from "./stored-text";

/** A stored scoped name: valid Unicode, bounded at 256 UTF-8 BYTES. */
export function storedName(value: unknown): string {
  const text = storedText(value);
  if (utf8ByteLength(text) > MAX_NAME_BYTES) failPublication("integrity_failure");
  return text;
}
