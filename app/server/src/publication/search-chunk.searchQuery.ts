import { requireBoundedText, requireNonemptyString, type Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import type { JcsValue } from "../contracts/jcs";

/** A CHOSEN wire cap for a search query, not a schema fact: long enough for a
 *  pasted paragraph (a semantic query), far below the 1 MiB request cap. */
export const MAX_QUERY_BYTES = 4096;

/**
 * The search query, VERBATIM: no trim, no case fold, no NFC. Keyword search is
 * a substring contract, so leading or trailing spaces are part of what the
 * caller asked to find. A query that is only whitespace asks for nothing and
 * is refused rather than answered with every chunk that holds a space.
 */
export function searchQuery(value: JcsValue | undefined, tokens: Tokens): string {
  const query = requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_QUERY_BYTES, tokens);
  if (/^\s*$/u.test(query)) fail("invalid_value", tokens, "query must contain a non-whitespace character");
  return query;
}
