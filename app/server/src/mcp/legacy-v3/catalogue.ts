/**
 * The v3-compatible tool family (#31 legacy adapters, docs/overnight/
 * V3-PARITY.md §2.1-2.2, §4; DECISIONS.md R18). DATA ONLY.
 *
 * 25 carried tools. The 5 never carried (oracle_mcp_call,
 * oracle_mcp_list_tools, oracle_trace_link, oracle_trace_unlink,
 * oracle_profile) have no entry at all, so the service cannot name an action
 * for them and they are indistinguishable from an unknown tool.
 *
 * Per entry:
 *  - `action`: the arra-auth/v1 action. `auth/service.toolAction.ts` DERIVES
 *    the service's map from this table, the same way it derives `kb_*` from
 *    the registry; the adapter never chooses a grant.
 *  - `uses`: the only registry methods the tool's `kb()` may call (A1).
 *  - `requires`: methods that must exist in `KNOWLEDGE_METHODS` before the tool
 *    is advertised (§2.1 rule c). A kernel slice that adds them makes the tool
 *    listable with no edit here; the handler table decides the rest.
 *  - `description`: rewritten for v4, stating each semantic change.
 *  - `inputSchema`: v3's argument names, so existing clients keep working.
 */

import type { WorkspaceAction } from "../../auth/policy";

export type V3ToolSpec = {
  readonly name: string;
  readonly action: Extract<WorkspaceAction, "content:read" | "content:write">;
  readonly uses: readonly string[];
  readonly requires: readonly string[];
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const RECALL = " Superseded and retired entries are excluded from recall (a v3 change: v3 still returned them).";
const NO_FILE = " Nothing is written to disk; LanceDB is canonical, so `file` is null.";
const TAXONOMY_READS = ["lookupVocabularyByName", "lookupTermByName"];
const TAXONOMY_WRITES = ["seedReservedVocabularies", "createVocabulary", "createTerm"];
const PUBLISH = [...TAXONOMY_READS, ...TAXONOMY_WRITES, "getPeer", "registerPeer", "publishRevision", "indexRevisionChunks"];
const PUBLISH_REQUIRES = [...TAXONOMY_READS, ...TAXONOMY_WRITES, "publishRevision", "indexRevisionChunks"];
/** K1 chunk search (#30 wave 2), named as V3-PARITY.md §5 designs it. */
const K1 = ["searchChunksKeyword", "searchChunksSemantic"];

const spec = (s: V3ToolSpec): V3ToolSpec => Object.freeze({ ...s, uses: Object.freeze([...s.uses]), requires: Object.freeze([...s.requires]) });

export const V3_CATALOGUE: readonly V3ToolSpec[] = Object.freeze([
  spec({
    name: "____IMPORTANT",
    action: "content:read",
    uses: [],
    requires: [],
    description: "Read first: how these v3-named tools behave on arra-oracle v4, what changed, and what is not carried.",
    inputSchema: obj({}),
  }),
  // ── knowledge writes (V1) ─────────────────────────────────────────────
  spec({
    name: "oracle_learn",
    action: "content:write",
    uses: PUBLISH,
    requires: PUBLISH_REQUIRES,
    description:
      "Save a learning to this bank as a v4 node of type learning, tagged with its concepts and one project (_universal when none)." +
      " It is indexed for search at once; its embedding is enqueued and filled later by the backfill (embedding: 'enqueued')." +
      NO_FILE + " The speaking peer (argument `peer`, else the X-Arra-Peer header) becomes the author.",
    inputSchema: obj(
      {
        pattern: str("Required. The learning itself; the first line (up to 80 characters) becomes the title."),
        concepts: strings("Free tags; created on first use."),
        project: str("owner/repo or github.com/owner/repo. cwd is never used to guess it."),
        source: str("Where it came from; stored with the revision."),
        peer: str("Optional speaker, bound by the credential's peers list."),
        idempotency_key: str("Optional. Makes a retry replay instead of writing twice."),
      },
      ["pattern"],
    ),
  }),
  spec({
    name: "oracle_research_note",
    action: "content:write",
    uses: PUBLISH,
    requires: PUBLISH_REQUIRES,
    description:
      "Save a research/dev note as a learning: evidence URLs become 'supports' links and repo+issue a 'discusses' link." +
      " Persona tags (thor-oracle, stormforge) are not added in v4; a compat warning says so." + NO_FILE,
    inputSchema: obj(
      {
        title: str("Required. The first line of the note and its title."),
        question: str(""),
        recommendation: str(""),
        repo: str("owner/repo; with issue, becomes a 'discusses' issue link."),
        issue: int("Issue number in repo."),
        repoEvidence: { type: "array", items: { type: "object" }, description: "{path, summary, url?} items; a url becomes a 'supports' link." },
        externalSources: { type: "array", items: { type: "object" }, description: "{url, title?, summary} items; each url becomes a 'supports' link." },
        hypotheses: strings(""),
        implementationPlan: strings(""),
        verificationPlan: strings(""),
        openQuestions: strings(""),
        concepts: strings(""),
        source: str(""),
        project: str(""),
        peer: str(""),
        idempotency_key: str(""),
      },
      ["title"],
    ),
  }),
  spec({
    name: "oracle_handoff",
    action: "content:write",
    uses: PUBLISH,
    requires: PUBLISH_REQUIRES,
    description:
      "Save a session handoff as a note tagged concepts:handoff and memory_horizon:short_term; the slug (or first line) is the title." +
      NO_FILE + " Every call is a new entry: v3's same-minute overwrite is gone.",
    inputSchema: obj(
      {
        content: str("Required. The handoff markdown."),
        slug: str("Short title."),
        project: str(""),
        session: str("Session name to file it under."),
        peer: str(""),
        idempotency_key: str(""),
      },
      ["content"],
    ),
  }),
  spec({
    name: "oracle_supersede",
    action: "content:write",
    uses: ["getAcceptedHead", "listLifecycleHistory", "supersedeNode", "getTerm"],
    requires: ["getAcceptedHead", "listLifecycleHistory", "supersedeNode"],
    description: "Mark one entry as replaced by another. The old entry leaves recall but stays readable by id, with superseded_by." + RECALL,
    inputSchema: obj({ oldId: str("Required."), newId: str("Required."), reason: str(""), peer: str("") }, ["oldId", "newId"]),
  }),
  // ── knowledge reads (V2, V5, V6, V8) ──────────────────────────────────
  spec({
    name: "oracle_search",
    action: "content:read",
    uses: [...K1, ...TAXONOMY_READS, "getAcceptedHead"],
    requires: K1,
    description:
      "Search this bank. Keyword search is character-trigram (finds Thai inside words); vector is semantic. hybrid runs keyword and says so:" +
      " fusion is not carried." + RECALL,
    inputSchema: obj(
      {
        query: str("Required."),
        type: str(""),
        limit: int(""),
        offset: int(""),
        mode: { type: "string", enum: ["hybrid", "fts", "vector"] },
        project: str(""),
      },
      ["query"],
    ),
  }),
  spec({
    name: "oracle_ask",
    action: "content:read",
    uses: [...K1, "answerFromKnowledge", "getAcceptedHead"],
    requires: ["searchChunksKeyword"],
    description: "Answer a question from this bank's knowledge, with citations; extractive when no model is configured." + RECALL,
    inputSchema: obj({ question: str("Required."), llm: { type: "boolean" }, limit: int("") }, ["question"]),
  }),
  spec({
    name: "oracle_read",
    action: "content:read",
    uses: ["getAcceptedHead", "listLifecycleHistory", "getRecallEligibility"],
    requires: ["getAcceptedHead", "listLifecycleHistory"],
    description: "Read one entry by id, including superseded or retired ones (flagged). Server files are not read: `file` is not carried.",
    inputSchema: obj({ id: str("Required."), file: str("Not carried in v4.") }),
  }),
  spec({
    name: "oracle_list",
    action: "content:read",
    uses: ["listNodes", "getAcceptedHead", "listLifecycleHistory", ...TAXONOMY_READS],
    requires: ["listNodes", "getAcceptedHead"],
    description: "Browse entries, including superseded ones (flagged). Paged with next_cursor.",
    inputSchema: obj({ type: str(""), limit: int(""), offset: int("") }),
  }),
  spec({
    name: "oracle_stats",
    action: "content:read",
    // K7 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 (K6+K7+V8)):
    // `knowledgeStats` carries total_documents/by_type/fts_indexed/
    // last_indexed/vector_status; `unique_concepts` needs one more hop
    // through the `concepts` vocabulary (`lookupVocabularyByName` then K6
    // `listTermUsage`), same composition `oracle_concepts` below uses. No
    // `listNodes` call remains (fix round: drift, this tool stopped calling
    // it once `knowledgeStats` landed).
    uses: ["knowledgeStats", "listTermUsage", "lookupVocabularyByName"],
    requires: ["knowledgeStats", "listTermUsage", "lookupVocabularyByName"],
    description:
      "Counts for this bank. Fields v4 cannot count yet are null and named in compat_warnings." +
      " Handoffs are entries in v4 (type note, concept handoff) and are counted; v3 kept them as inbox files.",
    inputSchema: obj({}),
  }),
  spec({
    name: "oracle_concepts",
    action: "content:read",
    // fix round: `requires` was missing `lookupVocabularyByName`, which this
    // tool calls before every `listTermUsage` (K2 resolve-by-name).
    uses: ["listTermUsage", "lookupVocabularyByName"],
    requires: ["listTermUsage", "lookupVocabularyByName"],
    description:
      "Concept tags in use in this bank, with counts over current entries." +
      " type filters on v4's own types (learning, note, conclusion, discussion, correction). v3's principle/pattern/retro" +
      " are stored as note plus a legacy_type tag, which this filter does not read: they match nothing, with a semantic_change warning.",
    inputSchema: obj({ type: str(""), limit: int("") }),
  }),
  spec({
    name: "oracle_reflect",
    action: "content:read",
    uses: ["listNodes", "getAcceptedHead"],
    requires: ["listNodes", "getAcceptedHead"],
    description: "One random learning from this bank." + RECALL,
    inputSchema: obj({}),
  }),
  spec({
    name: "oracle_recap",
    action: "content:read",
    uses: ["listNodes", "getAcceptedHead", ...TAXONOMY_READS],
    requires: ["listNodes", "getAcceptedHead"],
    description: "A markdown recap of the newest entries, grouped by project. Heat ranking is not carried." + RECALL,
    inputSchema: obj({ limit: int("") }),
  }),
  spec({
    name: "oracle_inbox",
    action: "content:read",
    uses: ["listNodes", "getAcceptedHead", ...TAXONOMY_READS],
    requires: ["listNodes", "getAcceptedHead"],
    description: "Handoffs in this bank, newest first. No inbox directory is read." + RECALL,
    inputSchema: obj({ limit: int(""), offset: int(""), type: str("") }),
  }),
  spec({
    name: "oracle_verify",
    action: "content:write",
    uses: ["reconcileSearchChunks"],
    requires: ["reconcileSearchChunks"],
    description: "Check that every current entry is indexed for search. check:false is not carried (it invented a successor).",
    inputSchema: obj({ check: { type: "boolean" }, type: str("") }),
  }),
  // ── forum (V4, V10) ───────────────────────────────────────────────────
  spec({
    name: "oracle_thread",
    action: "content:write",
    uses: ["getPeer", "registerPeer", "getSession", "registerSession", "joinSession", "appendMessages", "createSessionLink"],
    requires: ["getPeer", "registerPeer", "getSession", "registerSession", "joinSession", "appendMessages", "createSessionLink"],
    description: "Start or continue a thread (a v4 session). Needs a speaking peer. thread_id is the session name, a string.",
    inputSchema: obj(
      {
        message: str("Required."),
        threadId: { type: ["string", "integer"], description: "Session name. An integer is a v3 id and is not found." },
        title: str(""),
        role: str(""),
        reopen: { type: "boolean" },
        join: { type: "boolean" },
        to: strings(""),
        peer: str(""),
        idempotency_key: str(""),
      },
      ["message"],
    ),
  }),
  spec({
    name: "oracle_threads",
    action: "content:read",
    uses: ["listSessions"],
    requires: ["listSessions"],
    description: "List threads (sessions) in this bank, by name.",
    inputSchema: obj({ status: str(""), limit: int(""), offset: int("") }),
  }),
  spec({
    name: "oracle_thread_read",
    action: "content:read",
    uses: ["getSession", "listMessages"],
    requires: ["getSession", "listMessages"],
    description: "Read a thread's messages in order, as the speaking peer (membership is a read boundary). Reading never moves a read cursor.",
    inputSchema: obj({ threadId: { type: ["string", "integer"] }, limit: int(""), peer: str("") }, ["threadId"]),
  }),
  spec({
    name: "oracle_thread_update",
    action: "content:write",
    uses: ["getSession", "closeSession"],
    // closeSession (K9, ruling D7) is used when present; without it the tool
    // still answers active/answered/pending, and `closed` is not_yet_available.
    requires: ["getSession"],
    description: "Close a thread. answered and pending are not stored states in v4 and are refused.",
    inputSchema: obj({ threadId: { type: ["string", "integer"] }, status: str("Required.") }, ["threadId", "status"]),
  }),
  // ── traces (V3, V7) ───────────────────────────────────────────────────
  spec({
    name: "oracle_trace",
    action: "content:write",
    uses: ["createTrace", "getTrace"],
    requires: ["createTrace", "getTrace"],
    description:
      "Record a discovery trace. Full-length commits and issues become hits; files and learnings are kept in metadata, not indexed." +
      " Traces are immutable: link a follow-up with parentTraceId or prevTraceId at creation.",
    inputSchema: obj(
      {
        query: str("Required."),
        queryType: str(""),
        project: str(""),
        scope: str(""),
        parentTraceId: str(""),
        prevTraceId: str(""),
        agentCount: int(""),
        durationMs: int(""),
        foundFiles: { type: "array", items: { type: "object" } },
        foundCommits: { type: "array", items: { type: "object" } },
        foundIssues: { type: "array", items: { type: "object" } },
        foundRetrospectives: strings(""),
        foundLearnings: strings(""),
        foundResonance: strings(""),
        sessionId: str(""),
        peer: str(""),
        idempotency_key: str(""),
      },
      ["query"],
    ),
  }),
  spec({
    name: "oracle_trace_get",
    action: "content:read",
    uses: ["getTrace", "listTraceHits", "scanDependents", "getAcceptedHead"],
    requires: ["getTrace", "listTraceHits", "scanDependents"],
    description: "Read one trace. status is derived: distilled when an entry was derived from it.",
    inputSchema: obj({ traceId: str("Required."), includeChain: { type: "boolean" } }, ["traceId"]),
  }),
  spec({
    name: "oracle_trace_list",
    action: "content:read",
    uses: ["listTraces"],
    requires: ["listTraces"],
    description: "List traces, newest first.",
    inputSchema: obj({ query: str(""), status: str(""), limit: int(""), offset: int("") }),
  }),
  spec({
    name: "oracle_trace_chain",
    action: "content:read",
    uses: ["getTrace", "listTraces"],
    requires: ["getTrace"],
    description: "Walk a trace chain backward along prevTraceId; forward walking needs trace listing.",
    inputSchema: obj({ traceId: str("Required.") }, ["traceId"]),
  }),
  spec({
    name: "oracle_trace_distill",
    action: "content:write",
    uses: ["getTrace", ...PUBLISH],
    requires: ["getTrace", ...PUBLISH_REQUIRES],
    description:
      "Distill a trace into a new entry derived from it (learning when promoted, else conclusion). The trace itself is never rewritten;" +
      " distilling again adds a second entry.",
    inputSchema: obj(
      {
        traceId: str("Required."),
        awakening: str("Required."),
        promoteToLearning: { type: "boolean" },
        theme: str(""),
        concepts: strings(""),
        origin: str(""),
        idempotency_key: str(""),
      },
      ["traceId", "awakening"],
    ),
  }),
  spec({
    name: "oracle_search_chain",
    action: "content:write",
    uses: ["searchChunksSemantic", "listSearchChunks", "createTrace"],
    requires: ["searchChunksSemantic", "listSearchChunks", "createTrace"],
    description: "Follow semantic neighbours hop by hop, recording one trace per hop." + RECALL,
    inputSchema: obj({ query: str("Required."), maxHops: int(""), breadth: int("") }, ["query"]),
  }),
]);

export const V3_TOOL_NAMES: readonly string[] = Object.freeze(V3_CATALOGUE.map((t) => t.name));

/** What `tools/list` shows: name, description and schema, never the grant data. */
export const V3_TOOLS = Object.freeze(
  V3_CATALOGUE.map(({ name, description, inputSchema }) => Object.freeze({ name, description, inputSchema })),
);
