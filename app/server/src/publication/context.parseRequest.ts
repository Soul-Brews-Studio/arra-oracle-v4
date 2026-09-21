import type { Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import { parseStrictBytes, type JcsObject } from "../contracts/jcs";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;

export function parseRequest(bytes: Uint8Array, tokens: Tokens = []): JcsObject {
  if (!(bytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    fail("invalid_type", tokens, "expected request bytes");
  }
  const parsed = parseStrictBytes(bytes, tokens, {
    maxBytes: MAX_REQUEST_BYTES,
    maxDepth: MAX_REQUEST_DEPTH,
  });
  if (!(parsed instanceof Map)) fail("invalid_type", tokens, "expected object");
  return parsed as JcsObject;
}
