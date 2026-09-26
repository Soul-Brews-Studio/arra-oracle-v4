/**
 * Taxonomy request grammar, bootstrap literals and physical row encoding.
 *
 * PURE by contract. This module (this barrel plus its `taxonomy.*.ts`
 * siblings) must never import the storage SDK, and must never acquire,
 * retain or return an owner, adapter, connection or table. Taxonomy
 * persistence stays private in service.ts; everything in this module is
 * parsing, validation, encoding and errors, so it can be exercised without a
 * dataset and cannot become a back door to one.
 *
 * Contract: app/docs/contracts/taxonomy-write-v1.md
 *
 * This file is a thin barrel: one function/type per `taxonomy.<name>.ts`
 * sibling file, re-exported here so every importer keeps working unchanged.
 */

export {
  TAXONOMY_ERROR_VERSION,
  TAXONOMY_ERROR_CODES,
  type TaxonomyErrorCode,
  type TaxonomyErrorShape,
  TaxonomyError,
} from "./taxonomy.TaxonomyError";

export { failTaxonomy } from "./taxonomy.failTaxonomy";

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
} from "./taxonomy.constants";

export { type GetVocabularyRequest, parseGetVocabulary } from "./taxonomy.parseGetVocabulary";
export { parseGetTerm } from "./taxonomy.parseGetTerm";
export { type LookupVocabularyByNameRequest, parseLookupVocabularyByName } from "./taxonomy.parseLookupVocabularyByName";
export { type LookupTermByNameRequest, parseLookupTermByName } from "./taxonomy.parseLookupTermByName";
export { type GetTermRequest } from "./taxonomy.types";
export { type RetireTermRequest, parseRetireTerm } from "./taxonomy.parseRetireTerm";
export { type CreateVocabularyRequest, parseCreateVocabulary } from "./taxonomy.parseCreateVocabulary";
export { type CreateTermRequest, parseCreateTerm } from "./taxonomy.parseCreateTerm";
export { type RenameTermRequest, parseRenameTerm } from "./taxonomy.parseRenameTerm";
export { type ReparentTermRequest, parseReparentTerm } from "./taxonomy.parseReparentTerm";
export { type SeedRequest } from "./taxonomy.types";
export { parseSeedRequest } from "./taxonomy.parseSeedRequest";

export { encodeVocabularyRow } from "./taxonomy.encodeVocabularyRow";
export { encodeTermRow } from "./taxonomy.encodeTermRow";
export { seedVocabularyRows } from "./taxonomy.seedVocabularyRows";
export { seedTermRows } from "./taxonomy.seedTermRows";
