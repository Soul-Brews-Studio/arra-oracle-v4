import type { Tokens } from "../../contracts/common";
import { fail } from "../../contracts/errors";
import { hasOnlyPairedSurrogates, type JcsValue } from "../../contracts/jcs";

export function nullableOpaqueText(value: JcsValue | undefined, tokens: Tokens): string | null {
  // h_metadata / internal_metadata carry opaque JSON documents. No invented
  // bound beyond the whole-request byte cap: inventing a per-field ceiling
  // here would be a new rule this module has no contract basis for.
  const v = value ?? null;
  if (v === null) return null;
  if (typeof v !== "string") fail("invalid_type", tokens, "expected string");
  if (!hasOnlyPairedSurrogates(v)) fail("invalid_unicode", tokens, "unpaired surrogate");
  return v;
}
