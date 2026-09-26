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

export type { RequestAuthority };

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

/** Every write bundle also carries the full read surface (`...reads` spread
 *  in each writer factory), so this union covers both without a reader/writer
 *  split at the call site. */
export type KnowledgeBundle = EvidenceReaderBundle | Omit<EvidenceWriterBundle, "close">;

export type KnowledgeMethod = {
  readonly action: KnowledgeAction;
  /** Tokens to the object carrying `workspace_name`. `[]` means top-level. */
  readonly scopePath: readonly string[];
  /**
   * `authority` is built by the transport from the policy snapshot that
   * admitted this request (#87 / R3), never from its bytes. Only the message
   * reads consume it; every other entry ignores it. Peer-binding checks for
   * every method are declared in `registry.peerFields.ts`.
   */
  readonly call: (bundle: KnowledgeBundle, bytes: Uint8Array, authority: RequestAuthority) => Promise<unknown>;
  /**
   * True for a `content:write`-gated method that is defined only on the
   * writer facade but PERSISTS NOTHING (currently only `answerChat`). The
   * transport (`knowledge/transport.ts`'s `handleKnowledgeRequest`) opens a
   * fresh, uncached writer for these instead of the process-lifetime cached
   * one, and closes it when the request ends -- otherwise the FIRST call
   * would seize the exclusive dataset writer gate for the rest of the
   * process over a call that can never durably write. Absent/false means the
   * ordinary cached-writer path, unchanged for every other write method.
   */
  readonly ephemeralWrite?: boolean;
};

/** A reader bundle's `publication` facade has no `publishRevision`. */
function isWriterBundle(bundle: KnowledgeBundle): bundle is Omit<EvidenceWriterBundle, "close"> {
  return typeof (bundle as Omit<EvidenceWriterBundle, "close">).publication.publishRevision === "function";
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
  listNodes: {
    action: "content:read",
    scopePath: [],
    call: (bundle, bytes) => bundle.publication.listNodes(bytes),
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
  // lives on the reader facade, matching every other content:read method
  // above. `answerChat` is defined only on the writer facade (it needs the
  // injected `model` the writer alone carries) so it must run as
  // content:write even though it persists nothing -- but "runs as
  // content:write" here means ONLY the authorization action: `ephemeralWrite`
  // below tells the transport to open an uncached, per-request writer for it
  // rather than the process-lifetime cached one every other `content:write`
  // method shares, precisely because a persisting write must not be blocked
  // for the rest of the process by a call that persists nothing. With no
  // model configured at this deployment (`composeKnowledgeAccess` passes
  // none), it currently always answers `writer_unavailable` -- a real,
  // honestly-surfaced state, not a fabricated success.
  getContext: { action: "content:read", scopePath: [], call: (b, x) => b.context.getContext(x) },
  // Audit data, not content: entitles the caller to `h_metadata.auth.credential_id`
  // (see `context.encodeMcpCallRow.ts`), which `content:read` callers must
  // never see.
  listMcpCalls: { action: "audit:read", scopePath: [], call: (b, x) => b.context.listMcpCalls(x) },
  listConnections: { action: "audit:read", scopePath: [], call: (b, x) => b.context.listConnections(x) },
  answerChat: {
    action: "content:write",
    scopePath: [],
    ephemeralWrite: true,
    call: (b, x) => writer(b).context.answerChat(x),
  },

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

  // ── traces (#28) ─────────────────────────────────────────────────────────
  getTrace: { action: "content:read", scopePath: [], call: (b, x) => b.context.getTrace(x) },
  listTraceHits: { action: "content:read", scopePath: [], call: (b, x) => b.context.listTraceHits(x) },
  createTrace: {
    action: "content:write",
    scopePath: [],
    call: (b, x) => writer(b).context.createTrace(x),
  },

  // ── node lifecycle (#29) ─────────────────────────────────────────────────
  getRecallEligibility: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.context.getRecallEligibility(x),
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
  // `indexRevisionChunks`, `writeChunkEmbedding` and `reconcileSearchChunks`
  // are `content:write` per R8 (docs/overnight/DECISIONS.md), not internal:
  // an external embed worker runs the index-first/embed-later backfill Nat
  // asked for by calling these three directly, the same way any other
  // `content:write` caller reaches this table.
  listSearchChunks: {
    action: "content:read",
    scopePath: [],
    call: (b, x) => b.context.listSearchChunks(x),
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
