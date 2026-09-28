// Split out of session-link.ts (Nat style: one exported function per file).
// Shared by session-link.parseCreateSessionLink.ts (the `id` field) and
// session-link.parseListSessionLinks.ts (the `cursor` field, same namespace).

import { requireNanoid21, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

export function id(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}
