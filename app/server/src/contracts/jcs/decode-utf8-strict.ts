import { fail } from "../errors";
import { utf8Fatal } from "./codecs";

/** Decode bytes as UTF-8, rejecting malformed sequences. Byte cap is checked FIRST. */
export function decodeUtf8Strict(bytes: Uint8Array, maxBytes: number, tokens: Array<string | number>): string {
  if (bytes.byteLength > maxBytes) {
    fail("limit_exceeded", tokens, `document is ${bytes.byteLength} bytes; limit ${maxBytes}`);
  }
  try {
    return utf8Fatal.decode(bytes);
  } catch {
    return fail("invalid_unicode", tokens, "malformed UTF-8");
  }
}
