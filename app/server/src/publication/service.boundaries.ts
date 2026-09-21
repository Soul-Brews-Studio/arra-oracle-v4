/**
 * The four commanded sequence points a fault test may park at.
 *
 * A closed string set, deliberately: the callback receives no handle, no
 * context and no storage access, so it cannot become a side door into the
 * kernel. It demonstrates process death at SDK boundaries, NOT power-loss
 * atomicity.
 */
export type PublicationBoundary =
  | "before_append"
  | "after_revision_append"
  | "after_revision_readback"
  | "after_head_publication";

export type BoundaryHook = (boundary: PublicationBoundary) => Promise<void>;

/**
 * Taxonomy fault seam. Fires PER MUTATED ROW, never per staging phase: a
 * crash-after-the-third-term test can only name WHICH row was written if each
 * row emits its own triple.
 */
export type TaxonomyBoundary =
  | "before_write"
  | "after_term_write"
  | "after_vocabulary_write"
  | "after_update"
  | "after_readback";

export type TaxonomyBoundaryHook = (boundary: TaxonomyBoundary) => Promise<void>;

export type ContextBoundary = "before_write" | "after_write" | "after_readback";

export type ContextBoundaryHook = (boundary: ContextBoundary) => Promise<void>;

export type EvidenceBoundary =
  | "before_delete"
  | "after_delete"
  | "after_delete_readback"
  | "before_write"
  | "after_term_write"
  | "after_link_write"
  | "after_readback";

export type EvidenceBoundaryHook = (boundary: EvidenceBoundary) => Promise<void>;
