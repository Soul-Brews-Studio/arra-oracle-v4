import type { AuthErrorCode } from "./policy.types";

const MESSAGES: Readonly<Record<AuthErrorCode, string>> = Object.freeze({
  policy_invalid: "policy is invalid",
  invalid_request: "invalid request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
});

/**
 * Not exported from the module's public surface: the two runtime exports are
 * `parsePolicy` and `admit`. Callers discriminate on the readonly `code`,
 * never on the class or prose.
 */
export class AuthError extends Error {
  readonly code!: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(MESSAGES[code]);
    this.name = "AuthError";
    // `readonly` alone is erased at runtime, so define the property as
    // genuinely non-writable rather than claiming immutability TS cannot keep.
    Object.defineProperty(this, "code", {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}
