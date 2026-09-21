import { fail } from "../errors";
import { hasOnlyPairedSurrogates } from "./has-only-paired-surrogates";

/** JSON string per ECMAScript JSON.stringify — the escaping JCS mandates. */
export function canonicalString(s: string, tokens: Array<string | number> = []): string {
  if (!hasOnlyPairedSurrogates(s)) fail("invalid_unicode", tokens, "unpaired surrogate in string");
  return JSON.stringify(s);
}
