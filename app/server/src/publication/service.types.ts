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
  release(): void;
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

export type KnowledgeOptions = OperatorOptions & { onTaxonomyBoundary?: TaxonomyBoundaryHook };

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
