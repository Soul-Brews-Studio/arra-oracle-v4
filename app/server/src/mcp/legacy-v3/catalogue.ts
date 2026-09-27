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
 *  - `alsoNeeds`: actions the principal must hold on the bank as well, from
 *    the same snapshot (`auth/service.toolAlsoNeeds.ts`). Grants are exact
 *    (`auth/policy.admit.ts`): content:write never implies content:read, so
 *    a write tool whose ANSWER is bank content needs content:read too, as
 *    HTTP and `kb_*` would refuse that read to a write-only principal.
 *  - `uses`: the only registry methods the tool's `kb()` may call (A1).
 *  - `requires`: methods that must exist in `KNOWLEDGE_METHODS` before the tool
 *    is advertised (§2.1 rule c). A kernel slice that adds them makes the tool
 *    listable with no edit here; the handler table decides the rest.
 *  - `description`: rewritten for v4, stating each semantic change.
 *  - `inputSchema`: v3's argument names, so existing clients keep working.
 */

import {
  FORUM_WRITE,
  KEYWORD,
  NO_FILE,
  PUBLISH,
  PUBLISH_REQUIRES,
  RECALL,
  RECALL_FULL,
  SCORE,
  SEMANTIC,
  TAXONOMY_READS,
  TAXONOMY_WRITES,
} from "./catalogue.vocabulary";
import { int } from "./catalogue.int";
import { obj } from "./catalogue.obj";
import { spec } from "./catalogue.spec";
import { str } from "./catalogue.str";
import { strings } from "./catalogue.strings";
import type { V3ToolSpec } from "./catalogue.types";

export type { V3ToolSpec } from "./catalogue.types";

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
    // A7: peer_name is ensured the same way learn/handoff ensure their author
    // -- getPeer, else an idempotent registerPeer -- so a first-time speaker
    // does not need to have called a knowledge-write tool first.
    uses: ["getAcceptedHead", "listLifecycleHistory", "supersedeNode", "getTerm", "getPeer", "registerPeer"],
    requires: ["getAcceptedHead", "listLifecycleHistory", "supersedeNode"],
    description: "Mark one entry as replaced by another. The old entry leaves recall but stays readable by id, with superseded_by." + RECALL,
    inputSchema: obj({ oldId: str("Required."), newId: str("Required."), reason: str(""), peer: str("") }, ["oldId", "newId"]),
  }),
  // ── knowledge reads (V2, V5, V6, V8) ──────────────────────────────────
  spec({
    name: "oracle_search",
    action: "content:read",
    uses: [KEYWORD, SEMANTIC, "getAcceptedHead"],
    requires: [KEYWORD, SEMANTIC, "getAcceptedHead"],
    description:
      "Search this bank with v3's arguments. mode fts is keyword search over character trigrams, so Thai is found inside words" +
      " (a query under 3 characters is a substring scan, named in metadata.match). mode vector is semantic search over embedded" +
      " entries; if the query embedder does not answer it falls back to keyword and says so, as v3 did. hybrid, the default, is" +
      " answered by keyword search and says so: fusion is not carried (it measured worse)." + SCORE + RECALL,
    inputSchema: obj(
      {
        query: str("Required."),
        type: str("learning, or a v3 type (principle, pattern, retro) kept as legacy_type; all or absent means every type."),
        limit: int("Default 5. At most 50 entries are reachable per query."),
        offset: int("Default 0."),
        mode: { type: "string", enum: ["hybrid", "fts", "vector"] },
        project: str("owner/repo or github.com/owner/repo: that project, _universal entries and entries with no project (v3's project IS NULL)."),
        retrieval: { type: "string", enum: ["full", "compact-summary"], description: "compact-summary is not carried and is named as ignored." },
        model: str("Ignored: the embedding model is the server's."),
        asOf: str("Not carried: refused."),
      },
      ["query"],
    ),
  }),
  spec({
    name: "oracle_ask",
    action: "content:read",
    // answerFromKnowledge (K8) is the model-grounded answer V9 adds.
    uses: [KEYWORD, "answerFromKnowledge", "getAcceptedHead"],
    requires: [KEYWORD, "getAcceptedHead"],
    description:
      "Answer a question from this bank with cited sources: keyword search over the question, then v3's extractive answer" +
      " (the top three sources). llm:true needs a knowledge-grounded model method v4 does not have yet (not_yet_available):" +
      " it answers extractively and says so in compat_warnings." + SCORE + RECALL,
    inputSchema: obj({
      question: str("The question (or q)."),
      q: str("Alias of question."),
      type: str(""),
      limit: int("Sources to use, 1-20, default 8."),
      project: str(""),
      model: str("Ignored."),
      llm: { type: "boolean" },
    }),
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
    // R18 D3 fix round: `getRecallEligibility` flags each row the recall
    // tools would drop (`ineligible_reasons`).
    uses: ["listNodes", "getAcceptedHead", "listLifecycleHistory", "getRecallEligibility", ...TAXONOMY_READS],
    requires: ["listNodes", "getAcceptedHead"],
    // Fix round: this used to say "Paged with next_cursor", a field the
    // implementation never emitted -- corrected to name the field it
    // actually returns (`total`/`offset`/`limit`) rather than one it does not.
    description:
      "Browse entries, including superseded, retired, forgotten and expired ones, flagged (ineligible_reasons). Paged with offset/limit; total is exact when reachable.",
    inputSchema: obj({ type: str(""), limit: int(""), offset: int(""), asOf: str("Refused: there is no historical browse in v4.") }),
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
    // K3 fix round: samples the legacy_type:principle pool too, so it needs
    // the SAME by-name lookups `oracle_list`'s `type` filter already uses.
    uses: ["listNodes", "getAcceptedHead", ...TAXONOMY_READS],
    requires: ["listNodes", "getAcceptedHead"],
    description: "One random learning or principle from this bank." + RECALL_FULL,
    inputSchema: obj({}),
  }),
  spec({
    name: "oracle_recap",
    action: "content:read",
    uses: ["listNodes", "getAcceptedHead", ...TAXONOMY_READS],
    requires: ["listNodes", "getAcceptedHead"],
    // Fix round: returns the markdown STRING itself (v3 parity), not a JSON
    // object wrapping one.
    description: "A markdown recap of the newest entries, grouped by project. Heat ranking is not carried." + RECALL_FULL,
    inputSchema: obj({ limit: int(""), maxTokens: int("Accepted, ignored: v4 fits a fixed character budget instead.") }),
  }),
  spec({
    name: "oracle_inbox",
    action: "content:read",
    uses: ["listNodes", "getAcceptedHead", ...TAXONOMY_READS],
    requires: ["listNodes", "getAcceptedHead"],
    description: "Handoffs in this bank, newest first. No inbox directory is read." + RECALL_FULL,
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
    uses: [...FORUM_WRITE, "listSessionMembers"],
    requires: [...FORUM_WRITE, "listSessionMembers"],
    description:
      "Post to a thread, starting one when threadId is omitted. A thread is a v4 session and thread_id is its name (a string);" +
      " the speaking peer (argument `peer`, else the X-Arra-Peer header, bound by the credential's peers list) is the author" +
      " and a member. `to` adds other registered oracles as members, once the post is stored. A non-member must pass join:true:" +
      " v4 never joins silently. A member continues a closed thread with reopen:true, which starts a NEW thread linked" +
      " 'continues' to it and carries its members." +
      " No auto-answer: oracle_response is always null. title is display metadata; model is not stored yet.",
    inputSchema: obj(
      {
        message: str("Required. Not trimmed; must not be blank."),
        threadId: { type: ["string", "integer"], description: "Session name. An integer is a v3 id and is not found." },
        title: str("Display title of a new thread, at most 1024 UTF-8 bytes."),
        role: str("Stored as given; no default is invented."),
        to: strings("Registered peers to add as members."),
        join: { type: "boolean", description: "Join an existing thread before posting." },
        reopen: { type: "boolean", description: "Continue a closed thread in a new, linked thread." },
        model: str("Not stored yet; named in compat_warnings."),
        peer: str("Optional speaker, bound by the credential's peers list."),
        idempotency_key: str("Optional, and the speaker's own. Makes a retry replay instead of posting twice."),
      },
      ["message"],
    ),
  }),
  spec({
    name: "oracle_threads",
    action: "content:read",
    uses: ["listSessions"],
    requires: ["listSessions"],
    description:
      "List threads (sessions) by id. With a speaking peer, only the threads it belongs to (all:true for every thread in this bank)." +
      " status active or closed filters exactly; answered and pending are not stored in v4 and are refused." +
      " message_count and last_message are null (never read per thread). Page with next_cursor, not offset.",
    inputSchema: obj({
      status: str("active or closed."),
      limit: int("1..100, default 20."),
      cursor: str("next_cursor from a previous page."),
      all: { type: "boolean", description: "Every thread in this bank, not only the speaker's." },
      offset: int("Not supported (keyset paging); 0 or absent only."),
      peer: str("Optional speaker, bound by the credential's peers list."),
    }),
  }),
  spec({
    name: "oracle_thread_read",
    action: "content:read",
    uses: ["getSession", "listMessages"],
    requires: ["getSession", "listMessages"],
    description:
      "Read a thread's messages in order, as the speaking peer: membership is the read boundary, so a non-member is refused" +
      " (an audit:read credential may read with no speaker). limit N returns the last N. Reading never moves a read cursor.",
    inputSchema: obj(
      {
        threadId: { type: ["string", "integer"], description: "Session name. An integer is a v3 id and is not found." },
        limit: int("The last N messages (1..1000); all when omitted, up to 1000."),
        peer: str("Optional speaker, bound by the credential's peers list."),
      },
      ["threadId"],
    ),
  }),
  spec({
    name: "oracle_thread_update",
    action: "content:write",
    uses: ["getSession", "closeSession"],
    requires: ["getSession", "closeSession"],
    description:
      "Close a thread, one way, recording which member closed it and why. active is a no-op on an open thread and refused on a" +
      " closed one (continue it with oracle_thread reopen:true). answered and pending are not stored states in v4 and are refused.",
    inputSchema: obj(
      {
        threadId: { type: ["string", "integer"] },
        status: str("Required. closed or active."),
        reason: str("Why it was closed; recorded with the close."),
        peer: str("Optional speaker, bound by the credential's peers list."),
        idempotency_key: str("Optional. Makes a retry replay the same close."),
      },
      ["threadId", "status"],
    ),
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
    // K5 (V7): child_trace_ids and next_trace_id are filled from listTraces,
    // in this same build -- not gated in `requires` because getTrace,
    // listTraceHits and scanDependents alone already make the tool useful.
    uses: ["getTrace", "listTraceHits", "scanDependents", "getAcceptedHead", "listTraces"],
    requires: ["getTrace", "listTraceHits", "scanDependents"],
    description: "Read one trace. status is derived: distilled when an entry was derived from it. child_trace_ids and next_trace_id are filled from trace listing.",
    inputSchema: obj({ traceId: str("Required."), includeChain: { type: "boolean" } }, ["traceId"]),
  }),
  spec({
    name: "oracle_trace_list",
    action: "content:read",
    uses: ["listTraces"],
    requires: ["listTraces"],
    description:
      "List traces, newest first. query is a case-sensitive substring match (v3 used SQL LIKE). status is raw or distilled only:" +
      " a trace is immutable, so reviewed and distilling do not exist. total is not computed.",
    inputSchema: obj({
      query: str("Case-sensitive substring of the trace query."),
      project: str("Only traces recorded under exactly this project."),
      status: str("raw or distilled."),
      depth: int("Only traces at this depth (0 = top-level)."),
      limit: int(""),
      offset: int(""),
    }),
  }),
  spec({
    name: "oracle_trace_chain",
    action: "content:read",
    uses: ["getTrace", "listTraces"],
    requires: ["getTrace"],
    description:
      "Walk a trace chain backward along prevTraceId, then forward. Several traces may continue from one trace (a fork);" +
      " the forward walk stops there and names the branches.",
    inputSchema: obj({ traceId: str("Required.") }, ["traceId"]),
  }),
  spec({
    name: "oracle_trace_distill",
    action: "content:write",
    // reconcileRevisionAssociations materializes the derived_from link right
    // after publish, so K5's derived_from_count (has_awakening, status) sees
    // it without waiting for a separate backfill.
    uses: ["getTrace", ...PUBLISH, "reconcileRevisionAssociations"],
    requires: ["getTrace", ...PUBLISH_REQUIRES, "reconcileRevisionAssociations"],
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
    // It writes traces AND answers with the entries it found: both grants.
    alsoNeeds: ["content:read"],
    uses: [SEMANTIC, "getAcceptedHead", "createTrace", "getPeer", "registerPeer"],
    requires: [SEMANTIC, "getAcceptedHead", "createTrace"],
    description:
      "Follow semantic neighbours hop by hop from a seed query, recording one immutable trace per hop, each linked to the" +
      " previous one by prev_id. Needs content:read as well as content:write on the bank: it returns what it found." +
      " Later hops search by the best entry's text, re-embedded, not by its stored vector." +
      " Needs the query embedder; score is 1/(1+distance), and a hop whose best score falls below half the previous one stops the chain." +
      " idempotency_key makes a retry replay the same hop traces instead of writing new ones." +
      RECALL,
    inputSchema: obj(
      {
        query: str("Required."),
        maxHops: int("Default 3, at most 50."),
        breadth: int("Default 5, at most 50."),
        model: str("Ignored."),
        peer: str(""),
        idempotency_key: str("Optional. Derives each hop's trace id, so a client retry replays instead of writing twice."),
      },
      ["query"],
    ),
  }),
]);

export const V3_TOOL_NAMES: readonly string[] = Object.freeze(V3_CATALOGUE.map((t) => t.name));

/** What `tools/list` shows: name, description and schema, never the grant data. */
export const V3_TOOLS = Object.freeze(
  V3_CATALOGUE.map(({ name, description, inputSchema }) => Object.freeze({ name, description, inputSchema })),
);
