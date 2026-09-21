import { type JcsObject, type JcsValue, parseStrictBytes } from "../contracts/jcs";
import { failPublication, isContractError } from "./errors";
import { MAX_REQUEST_BYTES, MAX_REQUEST_DEPTH } from "./service.constants";

export function parseRequest(requestBytes: unknown): JcsObject {
  if (!(requestBytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    failPublication("invalid_request", "");
  }
  let parsed: JcsValue;
  try {
    parsed = parseStrictBytes(requestBytes, [], {
      maxBytes: MAX_REQUEST_BYTES,
      maxDepth: MAX_REQUEST_DEPTH,
    });
  } catch (error) {
    // Governed strict-parse failures keep their ORIGINAL arra-error/v1
    // envelope; only publication semantics use the separate codec.
    if (isContractError(error)) throw error;
    return failPublication("invalid_request", "");
  }
  if (!(parsed instanceof Map)) failPublication("invalid_request", "");
  return parsed as JcsObject;
}
