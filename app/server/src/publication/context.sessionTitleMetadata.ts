import { requireBoundedText, requireClosedObject, requireNonemptyString, type Tokens } from "../contracts/common";
import { canonicalize, type JcsValue } from "../contracts/jcs";

/** A CHOSEN wire cap for a display title, not a schema fact: a title is a
 *  label, and v3 clients sent a line of text, never a document. */
const MAX_TITLE_BYTES = 1024;

/**
 * K12a (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18): the OPTIONAL
 * display metadata `registerSession` may carry, as the canonical JSON text to
 * store in `sessions.h_metadata`, or null.
 *
 * Closed on purpose: exactly `{title}`, a nonempty valid-Unicode string. It
 * is DISPLAY data only -- the session name stays the immutable identity
 * (DESIGN.md:369), so a title is never matched, merged on or looked up by.
 * Omitted and `null` both mean "no title", and store null exactly as before
 * this amendment.
 */
export function sessionTitleMetadata(value: JcsValue | undefined, tokens: Tokens): string | null {
  if (value === undefined || value === null) return null;
  const o = requireClosedObject(value, ["title"], tokens);
  const titleTokens = [...tokens, "title"];
  const title = requireBoundedText(requireNonemptyString(o.get("title") ?? null, titleTokens), MAX_TITLE_BYTES, titleTokens);
  return canonicalize(new Map<string, JcsValue>([["title", title]]));
}
