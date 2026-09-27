import { PublicationError, type PublicationErrorCode } from "./errors.constants";

export function failPublication(code: PublicationErrorCode, path = ""): never {
  throw new PublicationError(code, path);
}
