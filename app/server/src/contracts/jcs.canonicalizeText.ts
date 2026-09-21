import { canonicalize } from "./jcs.canonicalize";
import { parseStrict } from "./jcs.parseStrict";

/** Canonical bytes: parse strictly, then serialize. */
export function canonicalizeText(text: string, tokens: Array<string | number> = []): string {
  return canonicalize(parseStrict(text, tokens), tokens);
}
