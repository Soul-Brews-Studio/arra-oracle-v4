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

export const TOOLS = [
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
        peer_name: { type: "string", description: "Who wrote it." },
        subject_peer_name: { type: "string", description: "Who it is ABOUT, if different." },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "Search this bank using ICU full-text by default or explicit vector mode. Full revision/lifecycle eligibility and embedding-profile enforcement remain planned.",
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
      "Deployment version, storage, authentication status, embedder health and tool count. Authentication is currently absent.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export const TOOL_NAMES = TOOLS.map((t) => t.name);
