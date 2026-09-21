import { canonicalize } from "./canonicalize";
import { parseStrict } from "./parse-strict";

/** Canonical bytes: parse strictly, then serialize. */
export function canonicalizeText(text: string, tokens: Array<string | number> = []): string {
  return canonicalize(parseStrict(text, tokens), tokens);
}
