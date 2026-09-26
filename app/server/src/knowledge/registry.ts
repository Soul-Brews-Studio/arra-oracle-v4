/**
 * Data-only route table for the publication/taxonomy/context/evidence
 * kernels (#31 transport exposure).
 *
 * Every method below is exactly what `publication/service.ts`'s
 * `EvidenceReaderBundle` / `EvidenceWriterBundle` already expose: raw
 * `Uint8Array` in, a plain JS value out (or a thrown `ContractError` /
 * `PublicationError` / `TaxonomyError`). This file adds NO parsing and NO
 * validation of its own — it only names which facade+method a wire name maps
 * to, which workspace-scope action it requires, and where in the request
 * body `workspace_name` lives so the transport can check it against the
 * admitted route scope BEFORE dispatch.
 *
 * Adding a method later is a data change: one new entry here, nothing else —
 * the HTTP route, the MCP tool list and the admission wiring all read this
 * table rather than naming methods individually.
 *
 * The session-link, trace, lifecycle and search-chunk kernels (#28/#29/#30)
 * are exposed below, alongside publication/taxonomy/context/evidence — this
 * table no longer excludes any facade method (#31 overnight R7/R8, tested
 * against a real gated dataset over both HTTP and MCP: see
 * `test/knowledge-expose13-live.test.ts`). `writeChunkEmbedding` is
 * `content:write` rather than internal-only per R8, so an external embed
 * worker can call it directly for the backfill loop Nat asked for. Every
 * write method below still goes through `writer()`, so an unauthenticated or
 * read-only caller cannot reach a real dataset write through this table —
 * see Step 3 of the recipe in `.tmp/understand/…architecture_r.md` for the
 * validation/auth layers a request crosses before a `call` here ever runs.
 */

import type { RequestAuthority } from "../publication/context";
import type { EvidenceReaderBundle, EvidenceWriterBundle } from "../publication/service";
import type { ChatService, SearchService } from "../publication/service.types";

export type { RequestAuthority };

/**
 * LAZY, deliberately -- matching `composition.ts`'s own discipline ("these
 * raw modules are imported lazily inside the builder so that merely
 * importing the composition graph cannot trigger their import-time
 * environment reads"). A STATIC top-level import here was tried first and
 * reverted: `mcp/calls.listMcpCalls.ts` / `mcp/connections.listConnections.ts`
 * import `./calls.openCallLogTable` / `./connections.openConnectionsTable`
 * (before fix round 2: `./calls` / `./connections`), which import `../storage`,
 * whose `DATA_DIR` is a `const` read from `process.env.ARRA_DATA_DIR` at
 * MODULE LOAD. A static import here pulls `storage.ts` into the STATIC
 * import graph of `app.ts` (via `knowledge/transport.ts` -> `composition.ts`),
 * which four test files (`transport-service`, `transport-ownership`,
 * `knowledge-chat-transport`, `knowledge-chat-writer-gate`) import statically
 * too -- so whichever of those Bun loads first freezes `DATA_DIR` for every
 * later file in the same `bun test` process, including ones that set
 * `ARRA_DATA_DIR` in their own `beforeAll`. Measured regression: `bun test
 * test/transport-service.test.ts test/mcp-correctness.test.ts` went from
 * 31 pass / 0 fail to 16 pass / 15 fail, and opened a real `<checkout>/app/data`.
 * A dynamic `import()` inside the closure below defers module resolution to
 * FIRST CALL, by which point every test file's own `beforeAll` has already
 * set `ARRA_DATA_DIR` for its own (fresh, `runOwnedChild`-owned) process.
 */
async function listMcpCallsFromOperationsRoot(bytes: Uint8Array): Promise<unknown> {
  return (await import("../mcp/calls.listMcpCalls")).listMcpCalls(bytes);
}
async function listConnectionsFromOperationsRoot(bytes: Uint8Array): Promise<unknown> {
  return (await import("../mcp/connections.listConnections")).listConnections(bytes);
}

/**
 * `audit:read` widened in for #94 (`listMcpCalls`/`listConnections`): the
 * runtime `admit()`/policy layer (`auth/policy.types.ts`'s `WorkspaceAction`)
 * already supports all four workspace actions, and `auth/service.ts`'s
 * `KNOWLEDGE_TOOL_ACTION` already derives `kb_<method>` grants generically
 * from whatever `entry.action` says here -- this type was the only place
 * still narrowed to two, not a deliberate scope boundary. Call-log data is
 * audit data (`authorization-integration-v1.md` §"Audit append"), so it is
 * gated the same way `MEMORY_TOOL_ACTION`'s `call_log`/`call_stats` already
 * are, not folded into `content:read`.
 */
export type KnowledgeAction = "content:read" | "content:write" | "audit:read";

/**
 * The READER bundle as the transport composes it: the evidence reader plus the
 * `chat` facade (#32 slice A, overnight ruling R9), built over that same
 * reader's `getContext` with the model composition configured. Optional in the
 * type only so a hand-written test fake need not carry it; the real
 * `createKnowledgeAccess` always attaches one. The reader's own context facade
 * also carries the #30 searches, opened with the composed query embedder
 * (`openEvidenceReader(root, {embedder})`), which no writer carries.
 */
export type KnowledgeReaderBundle = EvidenceReaderBundle & { readonly chat?: ChatService };

/** Every write bundle also carries the shared read surface (`...reads` spread
 *  in each writer factory), so this union covers both without a reader/writer
 *  split at the call site -- except the READER-only methods, which have their
 *  own backstops below: the `chat` facade (#32 / R9) and the #30 searches on
 *  the reader's context facade (`searches()`). */
export type KnowledgeBundle = KnowledgeReaderBundle | Omit<EvidenceWriterBundle, "close">;

export type KnowledgeMethod = {
  readonly action: KnowledgeAction;
  /** Tokens to the object carrying `workspace_name`. `[]` means top-level. */
  readonly scopePath: readonly string[];
  /**
   * `authority` is built by the transport from the policy snapshot that
   * admitted this request (#87 / R3), never from its bytes. Only the
   * membership-bounded reads (getMessage, listMessages, listSessionMembers)
   * and closeSession consume it; every other entry ignores it. Peer-binding
   * checks for every method are declared in `registry.peerFields.ts`.
   */
  readonly call: (bundle: KnowledgeBundle, bytes: Uint8Array, authority: RequestAuthority) => Promise<unknown>;
  /**
   * Operations-root methods (#103 / #102, DECISIONS.md R5): `mcp_calls` and
   * `connections` are written straight to `ARRA_DATA_DIR` on every admitted
   * request (`mcp/calls.ts`, `mcp/connections.ts`), never through the gated
   * `ARRA_KNOWLEDGE_DATASET_ROOT` writer. When present, the transport
   * (`knowledge/transport.ts`'s `handleKnowledgeRequest`, `mcp/index.ts`'s
   * `dispatchKnowledgeTool`) calls THIS instead of opening a knowledge
   * bundle -- `call` above is never invoked and
   * `ARRA_KNOWLEDGE_DATASET_ROOT` need not even be configured for the method
   * to answer. Admission (`action` above) is unchanged either way.
   */
  readonly operations?: (bytes: Uint8Array) => Promise<unknown>;
};

/** A reader bundle's `publication` facade has no `publishRevision`. */
function isWriterBundle(bundle: KnowledgeBundle): bundle is Omit<EvidenceWriterBundle, "close"> {
  return typeof (bundle as Omit<EvidenceWriterBundle, "close">).publication.publishRevision === "function";
}

/** The reader bundle's chat facade. A `content:read` method is always handed
 *  the reader, which `createKnowledgeAccess` composes with `chat`; its absence
 *  is a wiring mistake, never a request-facing case -- the same backstop as
 *  `writer()` below. */
function chat(bundle: KnowledgeBundle): ChatService {
  const facade = (bundle as KnowledgeReaderBundle).chat;
  if (facade === undefined) throw new Error("knowledge: this method requires the reader's chat facade");
  return facade;
}

/** The reader bundle's #30 searches. They live on the READER's context facade
 *  only -- the query embedder is composed onto the reader, like chat's model,
 *  and is never a writer option -- so a writer bundle here is a wiring
 *  mistake, never a request-facing case: the same backstop as `chat()`. */
function searches(bundle: KnowledgeBundle): SearchService {
  if (isWriterBundle(bundle)) throw new Error("knowledge: this method requires the reader bundle");
  return bundle.context;
}

function writer(bundle: KnowledgeBundle): Omit<EvidenceWriterBundle, "close"> {
  if (!isWriterBundle(bundle)) {
    // Never reached in practice: the transport only ever hands a write
    // method a bundle opened by `openEvidenceWriter`. This is a defensive
    // backstop against a future wiring mistake, not a request-facing case.
    throw new Error("knowledge: this method requires the writer bundle");
  }
  return bundle;
}

export const KNOWLEDGE_METHODS: Readonly<Record<string, KnowledgeMethod>> = Object.freeze({
  // ── publication ──────────────────────────────────────────────────────
  getAcceptedHead: {
    action: "content:read",
    scopePath: [],
    call: (bundle, bytes) => bundle.publication.getAcceptedHead(bytes),
  },
  listAcceptedHistory: {
    action: "content:read",
    scopePath: [],
    call: (bundle, bytes) => bundle.publication.listAcceptedHistory(bytes),
  },
  // R18 D3: `Date.now()` is the `eligible_only` recall view's `as_of`,
  // supplied here exactly as for `getRecallEligibility` below, so the kernel
  // takes no clock on a live call. A request without `eligible_only` never
  // reads it.
  listNodes: {
    action: "content:read",
    scopePath: [],
    call: (bundle, bytes) => bundle.publication.listNodes(bytes, Date.now()),
  },
  // The governed revision codec owns this envelope; workspace_name lives at
  // /content/workspace_name, not at the request root.
  publishRevision: {
    action: "content:write",
    scopePath: ["content"],
    call: (bundle, bytes) => writer(bundle).publication.publishRevision(bytes),
  },

  // ── taxonomy ─────────────────────────────────────────────────────────
  getVocabulary: { action: "content:read", scopePath: [], call: (b, x) => b.taxonomy.getVocabulary(x) },
  getTerm: { action: "content:read", scopePath: [], call: (b, x) => b.taxonomy.getTerm(x) },
  // K2 (docs/overnight/V3-PARITY.md §5, R18): by-name reads. The v3 adapter
  // needs them to find `type`, `concepts` or a concept term another writer
  // already created under its own id; before this, `createTerm` answered
  // `conflict /name` with no id and the caller was stuck.
  lookupVocabularyByName: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.taxonomy.lookupVocabularyByName(x),
  },
  lookupTermByName: { action: "content:read", scopePath: [], call: (b, x) => b.taxonomy.lookupTermByName(x) },
  // K6+K7 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 (K6+K7+V8)): a
  // plain term listing, per-vocabulary term usage counts over the accepted
  // heads' own term snapshots, and workspace-wide knowledge stats. The v3 adapter's `oracle_concepts` (K6) and `oracle_stats` (K7)
  // are the first callers (V8).
  listTerms: { action: "content:read", scopePath: [], call: (b, x) => b.taxonomy.listTerms(x) },
  listTermUsage: { action: "content:read", scopePath: [], call: (b, x) => b.taxonomy.listTermUsage(x) },
  knowledgeStats: { action: "content:read", scopePath: [], call: (b, x) => b.taxonomy.knowledgeStats(x) },
  createVocabulary: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).taxonomy.createVocabulary(x),
  },
  createTerm: { action: "content:write", scopePath: [], call: (b, x) => writer(b).taxonomy.createTerm(x) },
  renameTerm: { action: "content:write", scopePath: [], call: (b, x) => writer(b).taxonomy.renameTerm(x) },
  retireTerm: { action: "content:write", scopePath: [], call: (b, x) => writer(b).taxonomy.retireTerm(x) },
  reparentTerm: { action: "content:write", scopePath: [], call: (b, x) => writer(b).taxonomy.reparentTerm(x) },
  seedReservedVocabularies: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).taxonomy.seedReservedVocabularies(x),
  },

  // ── context ──────────────────────────────────────────────────────────
  getPeer: { action: "content:read", scopePath: [], call: (b, x) => b.context.getPeer(x) },
  getSession: { action: "content:read", scopePath: [], call: (b, x) => b.context.getSession(x) },
  // #87 / R3: membership is a read boundary on these two, so they take the
  // admitted authority (named requester -> CURRENT membership; none -> the
  // audit:read operator view).
  getMessage: { action: "content:read", scopePath: [], call: (b, x, a) => b.context.getMessage(x, a) },
  listMessages: { action: "content:read", scopePath: [], call: (b, x, a) => b.context.listMessages(x, a) },
  listPeers: { action: "content:read", scopePath: [], call: (b, x) => b.context.listPeers(x) },
  listSessions: { action: "content:read", scopePath: [], call: (b, x) => b.context.listSessions(x) },
  getReadCursor: { action: "content:read", scopePath: [], call: (b, x) => b.context.getReadCursor(x) },
  registerPeer: { action: "content:write", scopePath: [], call: (b, x) => writer(b).context.registerPeer(x) },
  registerSession: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.registerSession(x),
  },
  joinSession: { action: "content:write", scopePath: [], call: (b, x) => writer(b).context.joinSession(x) },
  appendMessages: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.appendMessages(x),
  },
  advanceReadCursor: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.advanceReadCursor(x),
  },
  // #33: evidence-grounded chat (#32). `getContext` is retrieval-only and
  // lives on the reader facade, matching every other content:read method.
  getContext: { action: "content:read", scopePath: [], call: (b, x) => b.context.getContext(x) },
  // Audit data, not content: entitles the caller to `h_metadata.auth.credential_id`
  // (see `context.encodeMcpCallRow.ts`), which `content:read` callers must
  // never see.
  //
  // `call` still names the target19 facade method -- frozen by the ownership
  // tests (`context-ownership.test.ts`, `context-service.test.ts`) and the
  // #34 cutover's eventual reader -- but `operations` below is what actually
  // answers today (R5): the target19 copies of these two tables are empty
  // until #34 migrates them, so `call` is unroutable until then.
  listMcpCalls: {
    action: "audit:read",
    scopePath: [],
    call: (b, x) => b.context.listMcpCalls(x),
    operations: (x) => listMcpCallsFromOperationsRoot(x),
  },
  listConnections: {
    action: "audit:read",
    scopePath: [],
    call: (b, x) => b.context.listConnections(x),
    operations: (x) => listConnectionsFromOperationsRoot(x),
  },
  // #32 slice A + B, overnight ruling R9: `answerChat` READS -- context
  // assembly, then one model call -- and persists nothing, so it is admitted
  // under `content:read` and runs on the reader bundle's `chat` facade. It
  // never opens, holds or releases a writer, so a chat can no longer lock
  // writes out of the process or be locked out by one. The model it calls is
  // composed from env (`src/chat-model.ts`); unconfigured or unreachable, it
  // answers the closed `model_unavailable` (503). Admitting it under the
  // same action as `getContext` widens nothing: the model sees exactly the
  // items `getContext` would return to this caller.
  answerChat: { action: "content:read", scopePath: [], call: (b, x) => chat(b).answerChat(x) },
  // The effective model settings, or `{model: null}`: model-free, dataset-free.
  getChatSettings: { action: "content:read", scopePath: [], call: (b, x) => chat(b).getChatSettings(x) },

  // ── session links (#28) ─────────────────────────────────────────────────
  // Every parser below carries `workspace_name` at the request root
  // (`session-link.ts`, `trace.ts`, `lifecycle.ts`, `search-chunk.ts`), so
  // every `scopePath` here is `[]`, same as the rest of this table.
  listSessionLinks: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.context.listSessionLinks(x),
  },
  createSessionLink: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.createSessionLink(x),
  },

  // ── forum kernels (overnight R18: K9 D7, K10) ─────────────────────────────
  // `closeSession` is the one-way close recorded in sessions.internal_metadata
  // (no new column); `listSessionMembers` is the first read of session_peers.
  // Both take the authority on R3 terms: members are listed AS a member (or
  // by the audit:read operator), and a close naming no peer is the operator's.
  // `listSessions`' K10 filters and `listMessages`' K11 tail are optional keys
  // on the entries above, not new methods.
  closeSession: { action: "content:write", scopePath: [], call: (b, x, a) => writer(b).context.closeSession(x, a) },
  listSessionMembers: { action: "content:read", scopePath: [], call: (b, x, a) => b.context.listSessionMembers(x, a) },

  // ── traces (#28) ─────────────────────────────────────────────────────────
  getTrace: { action: "content:read", scopePath: [], call: (b, x) => b.context.getTrace(x) },
  listTraceHits: { action: "content:read", scopePath: [], call: (b, x) => b.context.listTraceHits(x) },
  createTrace: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.createTrace(x),
  },
  // K5 (docs/overnight/V3-PARITY.md §5): newest-first listing, the v3
  // adapter's oracle_trace_list and the upgraded oracle_trace_chain
  // forward/oracle_trace_get children.
  listTraces: { action: "content:read", scopePath: [], call: (b, x) => b.context.listTraces(x) },

  // ── node lifecycle (#29) ─────────────────────────────────────────────────
  // #29 slice B (overnight R7): "the validity-window as_of is supplied by
  // the transport at request time, so the kernel still takes no clock" --
  // this registry table is that transport, shared by HTTP and MCP alike, and
  // this explicit `Date.now()` is where a LIVE call's real request time
  // enters (the #30 searches below pass theirs to the same eligibility check
  // the same way). Fix round correction: `service.getRecallEligibility.ts`
  // itself also has a `requestTimeMs ?? Date.now()` fallback, kept there only
  // for pre-existing in-process test harnesses that call it with a single
  // argument -- it is not the case that nothing but this registry line ever
  // calls `Date.now()`. See lifecycle-v1.md's amendment for both halves of
  // this.
  getRecallEligibility: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.context.getRecallEligibility(x, Date.now()),
  },
  listLifecycleHistory: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.context.listLifecycleHistory(x),
  },
  retireNode: { action: "content:write", scopePath: [], call: (b, x) => writer(b).context.retireNode(x) },
  supersedeNode: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.supersedeNode(x),
  },

  // ── search chunks (#30) ──────────────────────────────────────────────────
  // `indexRevisionChunks`, `writeChunkEmbedding`, `reconcileSearchChunks` and
  // `embedPendingChunks` are `content:write` per R8 (docs/overnight/DECISIONS.md),
  // not internal: an external embed worker runs the index-first/embed-later
  // backfill Nat asked for by calling these four directly, the same way any
  // other `content:write` caller reaches this table.
  listSearchChunks: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.context.listSearchChunks(x),
  },
  getSearchFreshness: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.context.getSearchFreshness(x),
  },
  indexRevisionChunks: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.indexRevisionChunks(x),
  },
  writeChunkEmbedding: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.writeChunkEmbedding(x),
  },
  reconcileSearchChunks: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.reconcileSearchChunks(x),
  },
  // #30 R8: the embed worker itself, exposed so HTTP, MCP and CLI `kb` all
  // reach the same backfill loop ("index first, embed later"). It writes
  // ONLY search_chunks_v1 rows `indexRevisionChunks` already created --
  // never node/revision content -- but it is still a real, durable write, so
  // it goes through the same `writer()` gate as every other content:write
  // method here.
  embedPendingChunks: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.embedPendingChunks(x),
  },

  // ── knowledge retrieval (#30, overnight R7 #30 part + R14) ───────────────
  // The recall path over the target-19 tier: keyword (shared ngram(3,3)
  // index, substring-verified, scan fallback that says so) and semantic
  // (injected query embedder, squared L2 over READY chunks of one profile).
  // Two methods, never fused (R7). Both run on the gateless READER, and
  // only there: they are not on any writer facade, a content:read caller
  // never opens the writer, and the reader never builds the text index --
  // `indexRevisionChunks` (writer) does. `Date.now()` is the recall
  // eligibility `as_of` (#29 validity windows), supplied here exactly as for
  // `getRecallEligibility` above, so the kernel takes no clock on a live call.
  searchKnowledgeKeyword: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => searches(b).searchKnowledgeKeyword(x, Date.now()),
  },
  searchKnowledgeSemantic: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => searches(b).searchKnowledgeSemantic(x, Date.now()),
  },

  // ── evidence ─────────────────────────────────────────────────────────
  getRevisionAssociations: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.evidence.getRevisionAssociations(x),
  },
  scanDependents: { action: "content:read", scopePath: [], call: (b, x) => b.evidence.scanDependents(x) },
  reconcileRevisionAssociations: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).evidence.reconcileRevisionAssociations(x),
  },
});

export const KNOWLEDGE_METHOD_NAMES: readonly string[] = Object.freeze(Object.keys(KNOWLEDGE_METHODS));
