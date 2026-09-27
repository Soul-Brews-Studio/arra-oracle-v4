import type { Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import { hasOnlyPairedSurrogates, type JcsValue } from "../contracts/jcs";

/**
 * Operation grammar: nonempty valid Unicode, deliberately NOT nanoid-shaped.
 * The caller owns this key across retries; narrowing it here would reject
 * legitimate operation IDs the contract allows. Mirrors requireOperationId in
 * service.ts, which this module cannot import (SDK-adjacent file).
 */
export function operationId(value: JcsValue | undefined, tokens: Tokens): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_type", tokens, "expected nonempty string");
  }
  if (!hasOnlyPairedSurrogates(value)) fail("invalid_unicode", tokens, "unpaired surrogate");
  return value;
}
