import { fail } from "./errors";
import { parseStrict } from "./jcs.parseStrict";
import type { JcsObject } from "./jcs.types";

/** Parse strict JSON text that MUST decode to an object. */
export function parseObjectText(text: string, tokens: Array<string | number>): JcsObject {
  const value = parseStrict(text, tokens);
  if (!(value instanceof Map)) fail("invalid_type", tokens, "JSON text must decode to an object");
  return value;
}
