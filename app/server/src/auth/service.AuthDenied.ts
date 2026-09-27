/**
 * The facade's one denial (`service.ts`). Split out so that file stays under
 * the line cap; `service.ts` re-exports both names unchanged.
 */

export type AuthFailure = "unauthenticated" | "forbidden" | "policy_unavailable" | "invalid_request";

export class AuthDenied extends Error {
  readonly code!: AuthFailure;

  constructor(code: AuthFailure) {
    super(code);
    this.name = "AuthDenied";
    Object.defineProperty(this, "code", {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}
