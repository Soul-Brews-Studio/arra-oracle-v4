import { failPublication } from "./errors";

/**
 * Operation grammar: nonempty valid Unicode.
 *
 * Deliberately NOT restricted to nanoid: the caller owns this key across
 * retries, and narrowing it here would reject legitimate operation IDs the
 * contract allows. No trimming and no case folding either -- the namespace is
 * the exact tuple (workspace_name, "node_revision", operation_id).
 */
export function requireOperationId(value: unknown, path: string): string {
  // Nonempty valid Unicode, and deliberately NOTHING more. An invented length
  // cap here would reject operation IDs the contract permits, and the 1 MiB
  // whole-request bound already limits it.
  if (typeof value !== "string" || value.length === 0) failPublication("invalid_request", path);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) failPublication("invalid_request", path);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failPublication("invalid_request", path);
    }
  }
  return value;
}
