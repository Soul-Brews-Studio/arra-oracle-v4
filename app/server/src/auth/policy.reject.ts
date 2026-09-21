import { AuthError } from "./policy.AuthError";
import type { AuthErrorCode } from "./policy.types";

export function reject(code: AuthErrorCode): never {
  throw new AuthError(code);
}
