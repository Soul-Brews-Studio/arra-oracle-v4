/**
 * Constants shared by two or more functions in this module, plus a few
 * module-scope literals that were unused in the original taxonomy.ts and are
 * kept exactly as they were (see the split report: `utf8ByteLength`,
 * `MAX_WORKSPACE_BYTES`, `NANOID21`).
 */

// Unused in the original file; kept for parity, not wired to anything.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { utf8ByteLength } from "../rows";

export const MAX_WORKSPACE_BYTES = 256;
export const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

export const RESERVED_VOCABULARY_NAMES = ["type", "memory_horizon"] as const;
export const VOCABULARY_KINDS = ["tags", "categories"] as const;
export const TERM_POLICIES = ["open", "sealed"] as const;
export const CARDINALITIES = ["one", "many"] as const;
export const HIERARCHIES = ["flat", "tree"] as const;

/** Physical order, quoted from target_v1/taxonomy.py:14. Not invented here. */
export const VOCABULARY_FIELDS = [
  "id", "name", "workspace_name", "label", "description", "kind",
  "term_policy", "cardinality", "required", "hierarchy",
  "h_metadata", "internal_metadata", "created_at",
] as const;

/** Physical order, quoted from target_v1/taxonomy.py:30. No label field exists. */
export const TERM_FIELDS = [
  "id", "workspace_name", "vocabulary_id", "name", "description",
  "parent_id", "weight", "is_active", "h_metadata", "created_at",
] as const;

export type VocabularyField = (typeof VOCABULARY_FIELDS)[number];
export type TermField = (typeof TERM_FIELDS)[number];

/** Literal staging order. Load-bearing: a crash prefix is only nameable if fixed. */
export const SEED_TERM_ORDER = [
  "note", "conclusion", "learning", "discussion", "correction",
  "short_term", "long_term",
] as const;
export const SEED_VOCABULARY_ORDER = ["type", "memory_horizon"] as const;

export const TYPE_TERMS = ["note", "conclusion", "learning", "discussion", "correction"] as const;
export const HORIZON_TERMS = ["short_term", "long_term"] as const;

export const MICROS_PER_MILLI = 1000n;
