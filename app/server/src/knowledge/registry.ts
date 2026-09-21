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
 * Deliberately excludes session-link, lifecycle, trace and search-chunk
 * kernels: they are mid-integration elsewhere and their method lists are
 * still moving (issue #31 scope note).
 */

import type { EvidenceReaderBundle, EvidenceWriterBundle } from "../publication/service";

export type KnowledgeAction = "content:read" | "content:write";

/** Every write bundle also carries the full read surface (`...reads` spread
 *  in each writer factory), so this union covers both without a reader/writer
 *  split at the call site. */
export type KnowledgeBundle = EvidenceReaderBundle | Omit<EvidenceWriterBundle, "close">;

export type KnowledgeMethod = {
  readonly action: KnowledgeAction;
  /** Tokens to the object carrying `workspace_name`. `[]` means top-level. */
  readonly scopePath: readonly string[];
  readonly call: (bundle: KnowledgeBundle, bytes: Uint8Array) => Promise<unknown>;
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
  getMessage: { action: "content:read", scopePath: [], call: (b, x) => b.context.getMessage(x) },
  listMessages: { action: "content:read", scopePath: [], call: (b, x) => b.context.listMessages(x) },
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
