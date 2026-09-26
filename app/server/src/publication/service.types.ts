import { type ChatModelFn } from "./chat";
import { type BoundaryHook, type ContextBoundary, type ContextBoundaryHook, type EvidenceBoundary, type EvidenceBoundaryHook, type PublicationBoundary, type TaxonomyBoundary, type TaxonomyBoundaryHook } from "./service.boundaries";
import { type createContextReadMethods } from "./service.createContextReadMethods";
import { type createContextWriterService } from "./service.createContextWriterService";
import { type createEvidenceReadMethods } from "./service.createEvidenceReadMethods";
import { type createEvidenceWriterService } from "./service.createEvidenceWriterService";
import { type createTaxonomyReadMethods } from "./service.createTaxonomyReadMethods";
import { type createTaxonomyWriterService } from "./service.createTaxonomyWriterService";
import { type getAcceptedHead } from "./service.getAcceptedHead";
import { type listAcceptedHistory } from "./service.listAcceptedHistory";
import { type listNodes } from "./service.listNodes";
import { type publishRevision } from "./service.publishRevision";

/**
 * The private dataset adapter.
 *
 * Deliberately NOT exported, and not constructible from `storage.ts` either:
 * that module exports validation helpers and raw-row decoding ONLY -- no
 * connection factory, no adapter, no table. Connection opening lives here,
 * private. So there is no importable factory anywhere that lets a caller
 * mutate the dataset without going through the scoped service built below.
 * Moving mutators behind an exported `openWriteAdapter` would only have
 * relocated the authority, not removed it.
 */
export type DatasetAdapter = {
  query(table: string, predicate: string, limit?: number): Promise<Record<string, unknown>[]>;
  /**
   * Ordered projection of a few key columns.
   *
   * PRIVATE, and separate from `query` on purpose. `query` has no ordering, so
   * a bare limit there returns ARBITRARY rows and can never yield an extremum
   * -- measured on the pinned stack. This is the only shape allowed to pick a
   * maximum or page a keyset.
   *
   * Ordered output bounds JS materialization. It does NOT bound SDK engine
   * scan work or execution time, and nothing here should be read as claiming
   * otherwise.
   */
  orderedProjection(
    table: string,
    predicate: string,
    columns: string[],
    ordering: { column: string; ascending: boolean },
    limit: number,
  ): Promise<Record<string, unknown>[]>;
  /**
   * Exact row count at a predicate, via the SDK's own `countRows(filter)` --
   * NOT a `query`/`orderedProjection` materialization counted in JS. This is
   * a second full scan of the predicate's rows with no keyset to bound it,
   * so it is for a caller that asked for a count DELIBERATELY (`total` on
   * `listPeers`/`listSessions`), never a cost every page fetch pays.
   */
  count(table: string, predicate: string): Promise<number>;
  /**
   * Scoped delete of DERIVED projection rows only.
   *
   * Deliberately NOT a generic delete. The table must be one of the two named
   * derived tables, and the predicate is CONSTRUCTED here from a workspace and
   * a revision id -- a caller cannot supply predicate text. Exposing
   * `delete(table, predicate)` would hand out a way to remove authoritative
   * rows, which nothing in this kernel is allowed to do.
   */
  deleteDerivedScope(
    table: "node_revision_terms" | "revision_links",
    workspace: string,
    revisionId: string,
  ): Promise<{ numDeletedRows: number; version: number }>;
  /**
   * Native, predicate-scoped row count -- the SDK's own `countRows`, which
   * never materializes a row into JS. `listNodes`' opt-in `include_total` is
   * the only caller: counting an open-ended workspace-scoped set has no
   * keyset to bound it, so this exists to answer that WITHOUT reading every
   * row through `query`/`orderedProjection` to count them by hand, which
   * would turn an opt-in sidebar total into an unbounded full scan through
   * this process instead of the SDK's own count path.
   */
  count(table: string, predicate: string): Promise<number>;
  refresh(table: string): Promise<void>;
  version(table: string): Promise<number>;
  append(table: string, rows: Record<string, unknown>[]): Promise<number>;
  updateWhere(
    table: string,
    predicate: string,
    assignments: Record<string, string>,
  ): Promise<{ rowsUpdated: number; version: number }>;
  /**
   * UPDATE-ONLY merge for a single, already-complete `search_chunks_v1` row
   * (#90's embed-step write path). Deliberately narrower than a generic
   * `mergeInsert` exposure: there is no `whenNotMatchedInsertAll`, so a row
   * whose `id` does not already exist is left untouched rather than created
   * -- this can UPDATE a chunk `indexRevisionChunks` wrote, never conjure one.
   * Hardcoded to one table for the same reason `deleteDerivedScope` is
   * restricted to two: a generic `table`/`row` surface would let a caller
   * mutate authoritative rows this kernel does not intend to expose that way.
   */
  updateSearchChunkEmbedding(row: Record<string, unknown>): Promise<number>;
  /**
   * #30 retrieval (overnight R7 #30 part + R14): leave exactly one FTS index
   * on `search_chunks_v1.text`, built from the shared `FTS_INDEX_OPTIONS`
   * (`fts/fts.constants.ts`); an index whose live details already match is
   * kept, one that differs is rebuilt under its own name, and a matching one
   * is rebuilt over every row once its unindexed rows reach its indexed rows
   * (`fts.refreshStaleFtsIndexOn`). WRITER-ONLY: the only caller is
   * `indexRevisionChunks`, in the owner's serialized queue.
   * A reader never builds or repairs an index -- it asks
   * `searchChunkTextIndexStatus` and scans when the answer is not `ready`.
   * Hardcoded to one table and column, like `updateSearchChunkEmbedding`.
   */
  ensureSearchChunkTextIndex(): Promise<string[]>;
  /** Read-only: whether the chunk-text index is the governed one (`fts.ftsIndexStatus`). */
  searchChunkTextIndexStatus(): Promise<"ready" | "missing" | "mismatched">;
  /**
   * Trigram full-text candidates on `search_chunks_v1.text`, BM25 order,
   * `predicate` applied as a PREFILTER (measured: a limit is filled from the
   * scoped rows, not cut before the scope). Rows carry `SEARCH_HIT_COLUMNS`
   * plus `_score`, decoded from raw Arrow like every other read here.
   */
  fullTextSearchChunks(query: string, predicate: string, limit: number): Promise<Record<string, unknown>[]>;
  /**
   * Nearest `search_chunks_v1.embedding` rows to `vector`, flat L2 search,
   * `predicate` as a prefilter. `_distance` is LanceDB's `l2`, which is the
   * SQUARED Euclidean distance (measured: orthogonal unit vectors -> 2).
   * Null embeddings are never candidates.
   */
  vectorSearchChunks(vector: number[], predicate: string, limit: number): Promise<Record<string, unknown>[]>;
  release(): void;
};

/**
 * #30 retrieval: the query-side embedder a semantic search is composed with,
 * injected exactly like `clock` and `model` -- never a network call this
 * kernel makes on its own. `profile` is the stored `embedding_profile` name
 * whose vector space `embed` produces; a search for any other profile is
 * refused, because a query embedded by one model and compared against
 * another model's vectors answers nothing meaningful.
 */
export type QueryEmbedder = {
  readonly profile: string;
  readonly embed: (text: string) => Promise<number[]>;
};

export type PublishOutcome =
  | {
      outcome: "accepted" | "idempotent";
      node_id: string;
      revision_id: string;
      revision_no: string;
      content_digest: string;
      node_created_at: string;
      revision_created_at: string;
    }
  | { outcome: "conflict"; reason: "operation_digest" | "node_id" | "stale_base" | "node_retired" };

export type Clock = () => number;

/** Mint revision IDs. Injected so tests are deterministic without stubbing time. */
export type IdSource = () => string;

export type ReadRequest = { workspace_name: string; node_id: string };

export type RevisionRow = Record<string, unknown>;

export type Ancestry = {
  /** Oldest first, exactly as `listAcceptedHistory` returns them. */
  rows: RevisionRow[];
  encoded: Record<string, unknown>[];
  wireBytes: number;
};

export type TermSnapshotEntry = {
  term_id: string;
  vocabulary_id: string;
  vocabulary_name_snapshot: string;
  term_name_snapshot: string;
  label_snapshot: string | null;
};

export type PublicationReaderService = {
  getAcceptedHead(requestBytes: Uint8Array): Promise<unknown>;
  listAcceptedHistory(requestBytes: Uint8Array): Promise<unknown>;
  listNodes(requestBytes: Uint8Array): Promise<unknown>;
};

export type PublicationWriterService = PublicationReaderService & {
  publishRevision(requestBytes: Uint8Array): Promise<PublishOutcome>;
  close(): Promise<void>;
};

/**
 * Writer service. Serialises every request through one promise queue, so two
 * operations cannot interleave inside a single process even though the
 * external gate already excludes other processes.
 */
/**
 * Writer service. PRIVATE for the same reason as the reader factory: the
 * only supported construction is `openPublicationWriter`.
 */
/**
 * The one module-private owner.
 *
 * Serial write queue, attempted-write tracking, fail-stop poison, released
 * state and the one-shot close live HERE rather than in a facade, so
 * publication and taxonomy genuinely SHARE them: a failure in either poisons
 * later writes in both. Nothing here is exported and nothing accepts
 * caller-asserted authority.
 */
export type OwnerCore = {
  serial: <T>(work: () => Promise<T>) => Promise<T>;
  boundary: (name: PublicationBoundary, wroteAlready: boolean) => Promise<void>;
  taxonomyBoundary: (name: TaxonomyBoundary, wroteAlready: boolean) => Promise<void>;
  contextBoundary: (name: ContextBoundary, wroteAlready: boolean) => Promise<void>;
  evidenceBoundary: (name: EvidenceBoundary, wroteAlready: boolean) => Promise<void>;
  markAttemptedWrite: () => void;
  afterWrite: <T>(work: () => Promise<T>) => Promise<T>;
  poison: () => void;
  close: () => Promise<void>;
};

export type OperatorOptions = {
  clock?: Clock;
  newRevisionId: IdSource;
  /** Trusted operator-only fault seam. Not request JSON, not an env hook. */
  onBoundary?: BoundaryHook;
  env?: NodeJS.ProcessEnv;
};

/** Build a complete physical revision row from validated canonical columns. */
export type BuiltRevision = {
  /** What goes to the SDK: Dates for timestamps, BigInts for Int64. */
  physical: Record<string, unknown>;
  /** What the row MUST read back as. Built from the same source values, so
   *  readback comparison never has to re-encode the Date-bearing write row. */
  wire: Record<string, unknown>;
};

export type TaxonomyRow = Record<string, unknown>;

export type MutationOutcome = { outcome: "created" | "already_satisfied" | "updated"; row: TaxonomyRow };

export type TaxonomyReaderService = ReturnType<typeof createTaxonomyReadMethods>;

export type TaxonomyWriterService = ReturnType<typeof createTaxonomyWriterService>;

export type KnowledgeReaderService = {
  publication: PublicationReaderService;
  taxonomy: TaxonomyReaderService;
};

export type KnowledgeWriterService = {
  publication: Omit<PublicationWriterService, "close">;
  taxonomy: TaxonomyWriterService;
  close: () => Promise<void>;
};

export type KnowledgeOptions = OperatorOptions & {
  onTaxonomyBoundary?: TaxonomyBoundaryHook;
  /** Trusted CONFIGURATION, never request JSON (R6, #27). `true` lets this
   *  owner's taxonomy facade create, rename, retire and reparent terms in a
   *  SEALED vocabulary: the operator lifecycle taxonomy-write-v1.md
   *  describes. Absent or false, those four refuse `invalid_request`. No
   *  transport sets it; `createKnowledgeAccess` opens ordinary writers. */
  taxonomyOperator?: boolean;
};

/** What each taxonomy mutator receives from its writer factory. */
export type TaxonomyWriteOptions = { clock: Clock; taxonomyOperator: boolean };

export type ContextRegistration =
  | { outcome: "created" | "already_satisfied"; row: Record<string, unknown> }
  | { outcome: "conflict"; reason: "id" | "name" | "membership" };

export type LifecycleSuccessor = { new_id: string; new_revision_id: string; new_title: string };

export type LifecycleEventInput = {
  workspace_name: string;
  node_id: string;
  expected_revision_id: string;
  reason: string;
  peer_name: string | null;
  operation_id: string;
  /** null for a retirement; both ids and the successor's title for a supersession. */
  successor: LifecycleSuccessor | null;
};

export type LifecycleWriteOutcome =
  | { outcome: "accepted"; row: Record<string, unknown> }
  | { outcome: "idempotent"; row: Record<string, unknown> }
  | {
      outcome: "conflict";
      reason: "operation_digest" | "stale_pin" | "already_terminal";
      row: Record<string, unknown> | null;
    };

export type LifecycleReplayClassification =
  | { replay: true; outcome: LifecycleWriteOutcome }
  | { replay: false };

export type ContextReaderService = ReturnType<typeof createContextReadMethods>;

export type ContextWriterService = ReturnType<typeof createContextWriterService>;

export type ContextReaderBundle = {
  publication: PublicationReaderService;
  taxonomy: TaxonomyReaderService;
  context: ContextReaderService;
};

export type ContextWriterBundle = {
  publication: Omit<PublicationWriterService, "close">;
  taxonomy: TaxonomyWriterService;
  context: ContextWriterService;
  close: () => Promise<void>;
};

export type ContextOptions = KnowledgeOptions & {
  /** Trusted CONFIGURATION, never request JSON. `null` selects local-only
   *  intake; a non-null value selects exactly that source namespace. It is not
   *  an authorization credential. */
  sourceNamespace: string | null;
  onContextBoundary?: ContextBoundaryHook;
  /** #32 chat's model call, injected exactly like `clock`. Absent means
   *  `answerChat` is unavailable (mapped through `mapModelFailure` on first
   *  use); never a network call this module makes on its own. */
  model?: ChatModelFn;
  /** #30 semantic search's query embedder. Absent means
   *  `searchKnowledgeSemantic` answers `writer_unavailable`, like chat with no model. */
  embedder?: QueryEmbedder;
};

export type SetAction = "unchanged" | "filled" | "rebuilt";

export type TableName = "node_revision_terms" | "revision_links";

export type EvidenceReaderService = ReturnType<typeof createEvidenceReadMethods>;

export type EvidenceWriterService = ReturnType<typeof createEvidenceWriterService>;

export type EvidenceReaderBundle = {
  publication: PublicationReaderService;
  taxonomy: TaxonomyReaderService;
  context: ContextReaderService;
  evidence: EvidenceReaderService;
};

export type EvidenceWriterBundle = {
  publication: Omit<PublicationWriterService, "close">;
  taxonomy: TaxonomyWriterService;
  context: ContextWriterService;
  evidence: EvidenceWriterService;
  close: () => Promise<void>;
};

export type EvidenceOptions = ContextOptions & { onEvidenceBoundary?: EvidenceBoundaryHook };
