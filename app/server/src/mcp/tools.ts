// The v1 tool catalogue (SPEC §6.2). Small on purpose — each tool must justify
// itself against "could the caller compose this from two others?".
//
// This slice ships the CONTENT and OBSERVABILITY tools, which the `memories`
// table already supports. Taxonomy (§6.2 tag/untag/term_*/vocabulary_*) waits
// on the terms/vocabularies write path.
//
// NEVER an MCP tool, in any policy (§6.2.2): create/rename/delete a bank or
// workspace, vocabulary_delete, changing a vocabulary's kind or term_policy,
// and every form of revoke (§7.4). A hallucinated `delete_bank` must have no
// path to exist.

import { KNOWLEDGE_METHOD_NAMES } from "../knowledge/registry";
import { PEER_FIELDS } from "../knowledge/registry.peerFields";

export const MEMORY_TOOLS = [
  {
    name: "remember",
    description:
      "Write durable text into the connected bank without model I/O. Returns pending embedding; run explicit backfill to create its vector.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, description: "Required. The memory itself." },
        name: { type: "string", minLength: 1, description: "Slug. Generated from content if omitted." },
        type: {
          type: "string",
          description:
            "Free-text type in the current spike; default note. Controlled taxonomy validation is planned, not implemented.",
        },
        session_name: { type: "string", description: "File it in a session. Organisation, not scope." },
        peer_name: {
          type: "string",
          description:
            "Who wrote it. When this credential's grant carries an arra-auth/v1 peers binding, it must be one of those peers, else the call is refused (forbidden) and nothing is stored.",
        },
        subject_peer_name: { type: "string", description: "Who it is ABOUT, if different." },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "Search this bank. Text mode (default) is a substring match: character-trigram full-text, every hit re-checked to contain the query (case-insensitive); a query under 3 characters is a bounded substring scan instead. The answer is {mode, match, count, rows}, with match 'ngram' or 'substring_scan'. Vector mode is explicit and has no match field. Full revision/lifecycle eligibility and embedding-profile enforcement remain planned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Required." },
        mode: { type: "string", enum: ["text", "vector"], description: "'text' (default) or 'vector'." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_memory",
    description: "Fetch one memory by id, with its provenance and sync state.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Required." } },
      required: ["id"],
    },
  },
  {
    name: "list_memories",
    description:
      "Filter by type, session, author/subject peer, sync_state or is_active before applying the limit. No continuation cursor yet; use recall for ranked search.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        session_name: { type: "string" },
        peer_name: { type: "string" },
        subject_peer_name: { type: "string" },
        sync_state: { type: "string", enum: ["pending", "synced", "failed"] },
        is_active: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 20." },
      },
    },
  },
  {
    name: "bank_info",
    description:
      "Scoped memory/embedded/unembedded counts, embedder configuration and storage metadata. Counts are not an authorization guarantee.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "call_log",
    description:
      "Recent MCP calls with arguments, outcome and duration — this server's own audit trail. Successes AND failures; a call that errored is the one you most want to read later (§6.3).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Default 20." },
        status: { type: "string", enum: ["ok", "error"], description: "Filter: ok | error." },
      },
    },
  },
  {
    name: "call_stats",
    description: "Aggregate call counts and failure rates per tool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "status",
    description:
      "Deployment version, storage, authentication status, embedder health, tool count and explicit active-vs-target contract state. Authentication is currently absent; target tables are not active.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/**
 * #31 knowledge-transport tools — one per `knowledge/registry.ts` entry.
 *
 * Data-driven ON PURPOSE: adding a publication/taxonomy/context/evidence
 * method is a registry change, not a new tool definition here. `payload` is
 * the exact JSON body `POST /api/knowledge/:bank/<method>` expects; the
 * dispatcher in `mcp/index.ts` re-encodes it to bytes and hands it to the
 * SAME registry entry the HTTP transport uses, so both surfaces share one
 * parser and one validator.
 */
/**
 * #87 / R3 (docs/overnight/DECISIONS.md): the message reads carry an
 * authorization rule a generic "exact request body" line would hide, so the
 * catalogue states it and declares the one optional payload key.
 */
const READ_BOUNDARY_NOTE =
  " Membership is a read boundary: set payload.requester_peer_name to read as that peer, which must be a CURRENT" +
  " member of the message's session (a stranger or departed member is refused; getMessage answers null)." +
  " Omit it for the operator view, which needs audit:read on this bank; a content:read-only credential that" +
  " names no requester is refused with forbidden.";
const REQUESTER_PROPERTY = {
  requester_peer_name: {
    type: "string",
    description: "Optional. The peer reading; omit (or null) for the audit:read operator view.",
  },
};
const READ_BOUNDARY_METHODS: ReadonlySet<string> = new Set(["getMessage", "listMessages"]);

/** Methods whose payload names an ACTING peer (`registry.peerFields.ts`). */
const BINDING_NOTE =
  " If this credential's grant carries an arra-auth/v1 peers binding, every acting-peer field must name a bound" +
  " peer, else forbidden.";

export const KNOWLEDGE_TOOLS = KNOWLEDGE_METHOD_NAMES.map((method) => ({
  name: `kb_${method}`,
  description:
    `Publication/taxonomy/context/evidence kernel method "${method}", scoped to this connection's bank.` +
    (READ_BOUNDARY_METHODS.has(method) ? READ_BOUNDARY_NOTE : "") +
    (Object.hasOwn(PEER_FIELDS, method) ? BINDING_NOTE : ""),
  inputSchema: {
    type: "object",
    properties: {
      payload: {
        type: "object",
        description: "The exact request body this method's HTTP route expects.",
        ...(READ_BOUNDARY_METHODS.has(method) ? { properties: REQUESTER_PROPERTY } : {}),
      },
    },
    required: ["payload"],
  },
}));

export const TOOLS = [...MEMORY_TOOLS, ...KNOWLEDGE_TOOLS];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
