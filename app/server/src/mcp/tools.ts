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
      "Write a memory into the connected bank. Returns immediately after the row is durable; the vector is backfilled, so an embedder outage never blocks a write.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Required. The memory itself." },
        name: { type: "string", description: "Slug. Generated from content if omitted." },
        type: {
          type: "string",
          description:
            "Free text guarded by the `type` vocabulary, not an enum. Default 'note'. Seen: note, decision, event.",
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
      "Search this bank. Default mode is full-text (trigram/ICU), which this fleet measures at MRR 0.765 against 0.099 for vectors. Semantic is an explicit, separate mode (§4.4).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Required." },
        mode: { type: "string", description: "'text' (default) or 'vector'." },
        limit: { type: "number", description: "Default 10." },
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
      "Filter by type, session, peer, sync_state or is_active. Paginated. Use this rather than recall when you want a slice, not a ranking.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        session_name: { type: "string" },
        peer_name: { type: "string" },
        sync_state: { type: "string", description: "pending | synced | failed" },
        limit: { type: "number", description: "Default 20." },
      },
    },
  },
  {
    name: "bank_info",
    description:
      "What this bank is: counts, embedder identity, storage backend, and the two consistency gaps an operator needs to see (unembedded rows, failed rows).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "call_log",
    description:
      "Recent MCP calls with arguments, outcome and duration — this server's own audit trail. Successes AND failures; a call that errored is the one you most want to read later (§6.3).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 20." },
        status: { type: "string", description: "Filter: ok | error." },
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
      "Deployment state in one object — version, storage, auth doors, embedder, table count. Names the doors rather than saying 'ok' (§6.4), so a caller learns before spending ten minutes that something is off.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export const TOOL_NAMES = TOOLS.map((t) => t.name);
