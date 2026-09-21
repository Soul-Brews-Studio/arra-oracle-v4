import { AuthError } from "./auth-error";
import type { AuthErrorCode } from "./types";

export function reject(code: AuthErrorCode): never {
  throw new AuthError(code);
}
