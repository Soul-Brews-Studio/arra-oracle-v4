// Split from chat.ts (style-split4b, 2026-09-28): shared bytes-to-object entry
// every chat request parser starts from.
import type { Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import { parseStrictBytes, type JcsObject } from "../contracts/jcs";
import { MAX_REQUEST_BYTES, MAX_REQUEST_DEPTH } from "./chat.state";

export function parseRequest(bytes: Uint8Array, tokens: Tokens = []): JcsObject {
  if (!(bytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    fail("invalid_type", tokens, "expected request bytes");
  }
  const parsed = parseStrictBytes(bytes, tokens, { maxBytes: MAX_REQUEST_BYTES, maxDepth: MAX_REQUEST_DEPTH });
  if (!(parsed instanceof Map)) fail("invalid_type", tokens, "expected object");
  return parsed as JcsObject;
}
