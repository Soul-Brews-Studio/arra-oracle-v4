// Split out of read-cursor.ts (Nat style: one exported function per file).
// Shared by read-cursor.parseGetReadCursor.ts and
// read-cursor.parseAdvanceReadCursor.ts -- a genuine multi-caller helper, so
// it gets its own single-export file rather than living privately in either.

import { fail } from "../contracts/errors";
import { parseStrictBytes, type JcsObject } from "../contracts/jcs";
import type { Tokens } from "../contracts/common";
import { MAX_REQUEST_BYTES, MAX_REQUEST_DEPTH } from "./read-cursor.constants";

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
