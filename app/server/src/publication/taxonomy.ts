/**
 * Taxonomy request grammar, bootstrap literals and physical row encoding.
 *
 * PURE by contract. This module must never import the storage SDK, and must
 * never acquire, retain or return an owner, adapter, connection or table.
 * Taxonomy persistence stays private in service.ts; everything here is
 * parsing, validation, encoding and errors, so it can be exercised without a
 * dataset and cannot become a back door to one.
 *
 * Contract: app/docs/contracts/taxonomy-write-v1.md
 *
 * This file is a thin barrel: one function/type per file under ./taxonomy/,
 * re-exported here so every importer keeps working unchanged.
 */

export {
  TAXONOMY_ERROR_VERSION,
  TAXONOMY_ERROR_CODES,
  type TaxonomyErrorCode,
  type TaxonomyErrorShape,
  TaxonomyError,
} from "./taxonomy/taxonomy-error";

export { failTaxonomy } from "./taxonomy/fail-taxonomy";

export {
  RESERVED_VOCABULARY_NAMES,
  VOCABULARY_KINDS,
  TERM_POLICIES,
  CARDINALITIES,
  HIERARCHIES,
  VOCABULARY_FIELDS,
  TERM_FIELDS,
  type VocabularyField,
  type TermField,
  SEED_TERM_ORDER,
  SEED_VOCABULARY_ORDER,
} from "./taxonomy/constants";

export { type GetVocabularyRequest, parseGetVocabulary } from "./taxonomy/parse-get-vocabulary";
export { parseGetTerm } from "./taxonomy/parse-get-term";
export { type GetTermRequest } from "./taxonomy/types";
export { type RetireTermRequest, parseRetireTerm } from "./taxonomy/parse-retire-term";
export { type CreateVocabularyRequest, parseCreateVocabulary } from "./taxonomy/parse-create-vocabulary";
export { type CreateTermRequest, parseCreateTerm } from "./taxonomy/parse-create-term";
export { type RenameTermRequest, parseRenameTerm } from "./taxonomy/parse-rename-term";
export { type ReparentTermRequest, parseReparentTerm } from "./taxonomy/parse-reparent-term";
export { type SeedRequest } from "./taxonomy/types";
export { parseSeedRequest } from "./taxonomy/parse-seed-request";

export { encodeVocabularyRow } from "./taxonomy/encode-vocabulary-row";
export { encodeTermRow } from "./taxonomy/encode-term-row";
export { seedVocabularyRows } from "./taxonomy/seed-vocabulary-rows";
export { seedTermRows } from "./taxonomy/seed-term-rows";
