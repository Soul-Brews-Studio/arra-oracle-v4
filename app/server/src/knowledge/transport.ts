/**
 * Transport for the publication/taxonomy/context/evidence kernels (#31).
 *
 * The measured constraint this file exists to preserve: every method in
 * `registry.ts` runs a governed strict parser over raw BYTES with a 1 MiB
 * limit, depth 64, duplicate-key rejection and valid-UTF-8 enforcement. A
 * transport that JSON-parses before handing bytes to the facade silently
 * destroys two of those guarantees (`JSON.parse` is last-wins on duplicate
 * keys, and a size check after parsing is not a byte limit). So: the ORIGINAL
 * `Uint8Array` read off the wire is the exact same object handed to
 * `KnowledgeMethod.call`, never re-encoded, never re-serialized.
 *
 * Scope handling mirrors the existing `POST /api/memories` precedent in
 * `app.createApp.ts`: the route's `:bank` segment is the authoritative, admitted
 * workspace. Because several of these methods carry `workspace_name` inside
 * the body (the admission layer for #25 never anticipated a body-scoped
 * kernel with this many entrypoints), the body is peeked with the SAME
 * governed parser used everywhere else in this package, purely to check that
 * its `workspace_name` equals the admitted route bank. A caller naming a
 * DIFFERENT workspace in the body than the one admitted in the URL is a bad
 * request, not a bypass: "names in requests are NOT authorization" (per the
 * task brief) means the ROUTE bank decides the grant, and the body is only
 * trusted once it agrees with it. The original bytes are still what reaches
 * the service — the peek discards its own parse result immediately after
 * the comparison.
 *
 * Writer ownership and chat composition are documented in
 * `transport.createKnowledgeAccess.ts`'s own header.
 *
 * This file is now a barrel (style-split4b, 2026-09-28): each exported
 * function moved verbatim to its own transport.<fn>.ts, and the shared
 * constants/types moved to transport.state.ts (data only). Re-exported here
 * so every existing importer (`./knowledge/transport` / `../knowledge/transport`
 * / `../../knowledge/transport`) keeps working unchanged.
 */

export {
  MAX_KNOWLEDGE_REQUEST_BYTES,
  type RawBody,
  type KnowledgeDatasetConfig,
  type KnowledgeAccess,
} from "./transport.state";
export { isRejection } from "./transport.isRejection";
export { readKnowledgeBody } from "./transport.readKnowledgeBody";
export { knowledgeErrorResponse } from "./transport.knowledgeErrorResponse";
export { peekWorkspaceName } from "./transport.peekWorkspaceName";

// ── admission ────────────────────────────────────────────────────────────

export { KnowledgeAuthDenied, admitKnowledgeAction, type KnowledgeAuthFailure } from "./transport.admitKnowledgeAction";
export { requireBoundPeers } from "./transport.requireBoundPeers";

// ── dataset access (writer-ownership decision documented there) ───────────

export { createKnowledgeAccess } from "./transport.createKnowledgeAccess";

// ── HTTP handler ────────────────────────────────────────────────────────

export { handleKnowledgeRequest } from "./transport.handleKnowledgeRequest";
