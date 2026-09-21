import { parseStrictBytes, type JcsValue } from "../../contracts/jcs";
import { isContractError } from "../errors";
import { failTaxonomy } from "./fail-taxonomy";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;

/**
 * Strict SHAPE failures keep the governed `arra-error/v1` envelope.
 *
 * Missing keys, unknown keys, wrong types, bad enums and non-Booleans are
 * grammar, not taxonomy semantics, so they go through the shared
 * `contracts/common` helpers rather than a second copy of the same rules
 * pinned to this module. That also inherits the helpers' RFC 6901 escaping
 * and their deterministic unknown-key ordering, neither of which a local
 * string-concatenated path would reproduce.
 *
 * Only taxonomy SEMANTICS -- reserved names, duplicate manifest identities,
 * stored-state corruption -- use the taxonomy envelope.
 */
export function parseRequest(bytes: Uint8Array): JcsValue {
  if (!(bytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    failTaxonomy("invalid_request", "");
  }
  try {
    return parseStrictBytes(bytes, [], {
      maxBytes: MAX_REQUEST_BYTES,
      maxDepth: MAX_REQUEST_DEPTH,
    });
  } catch (error) {
    if (isContractError(error)) throw error;
    return failTaxonomy("invalid_request", "");
  }
}
