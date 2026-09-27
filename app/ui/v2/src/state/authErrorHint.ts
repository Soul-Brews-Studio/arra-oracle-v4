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
  // #33 AC2 round 3: `forbidden` is ALSO what `transport.requireBoundPeers`
  // answers when the token is not bound to the peer a request names (R3) --
  // the scope can be right and the binding the cause -- so the sentence
  // names both rather than blaming the scope alone.
  if (code === "forbidden") {
    return "This token is not allowed to do this: it lacks the permission (scope) this request needs, or it is not bound to the peer the request names. Use a token with the right grant and peer binding, or switch workspace.";
  }
  return null;
}
