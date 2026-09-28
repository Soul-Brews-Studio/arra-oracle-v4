// Split from transport.ts (style-split4b, 2026-09-28).
import { parseStrictBytes, type JcsObject, type JcsValue } from "../contracts/jcs";
import { MAX_KNOWLEDGE_REQUEST_BYTES, MAX_KNOWLEDGE_REQUEST_DEPTH } from "./transport.state";

/** Walk a Map-shaped parse result to the object naming `workspace_name`. */
function readWorkspaceAt(value: JcsValue, tokens: readonly string[]): string | null {
  let node: JcsValue = value;
  for (const token of tokens) {
    if (!(node instanceof Map)) return null;
    const next = node.get(token);
    if (next === undefined) return null;
    node = next;
  }
  if (!(node instanceof Map)) return null;
  const workspace = (node as JcsObject).get("workspace_name");
  return typeof workspace === "string" ? workspace : null;
}

/**
 * Parse the body ONCE with the governed strict parser, purely to read the
 * scope carrier. Throws the exact `ContractError` on a malformed document —
 * callers propagate it unchanged via `knowledgeErrorResponse`. Returns null
 * (never throws) when the document parses but simply has no valid
 * `workspace_name` at the expected path: that is a plain scope mismatch, not
 * a wire-format fault.
 */
export function peekWorkspaceName(bytes: Uint8Array, scopePath: readonly string[]): string | null {
  const parsed = parseStrictBytes(bytes, [], {
    maxBytes: MAX_KNOWLEDGE_REQUEST_BYTES,
    maxDepth: MAX_KNOWLEDGE_REQUEST_DEPTH,
  });
  return readWorkspaceAt(parsed, scopePath);
}
