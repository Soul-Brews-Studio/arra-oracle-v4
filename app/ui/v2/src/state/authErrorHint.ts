/** #33 AC2/R12 (a11y slice), requirement 3: "a clear, honest message for 401
 *  (bad token) and for 403 / insufficient scope, never a blank or generic
 *  failure." Pure mapping from the governed error CODE (post-`asError`,
 *  post-`describe()`) to one extra sentence a human can act on. `null` means
 *  "no specific hint for this code" -- callers keep showing the bare code and
 *  message as before, they just add this sentence when it exists.
 *
 * The two codes come from `auth/http.ts`'s `ERROR_BODIES` (401 ->
 * `"unauthenticated"`, 403 -> `"forbidden"`), which is the SAME gate every
 * transport shares (Host/Origin/bearer, `app.ts:onRequest`/`onBeforeHandle`),
 * so this one mapping covers memory routes, knowledge routes and MCP alike.
 */
export function authErrorHint(code: string | null | undefined): string | null {
  if (code === "unauthenticated") {
    return "No bearer token, or the token is not valid. Check the token field above and try again.";
  }
  if (code === "forbidden") {
    return "This token does not hold the permission (scope) this request needs. Ask for a token with the right grant, or switch workspace.";
  }
  return null;
}
