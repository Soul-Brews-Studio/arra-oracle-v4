import { authErrorHint } from "./authErrorHint";

/** `authErrorHint` for a DISPLAY string rather than a bare code. `describe()`
 *  renders an envelope as `code` or `code at <pointer>`, and an R3
 *  peer-binding refusal carries a pointer (`forbidden at /peer_name`), so the
 *  code is the first word. Round 3 did this inline in `Transcript` only; the
 *  `ErrorNote` aside matched the whole string and lost the hint for the very
 *  same error (#33 AC2 round 4). */
export function authErrorHintFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  return authErrorHint(text.split(" ", 1)[0]);
}
