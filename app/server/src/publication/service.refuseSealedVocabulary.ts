import { failTaxonomy } from "./taxonomy";
import { type TaxonomyRow, type TaxonomyWriteOptions } from "./service.types";

/**
 * R6 (#27): a sealed vocabulary is sealed on every transport.
 *
 * `vocabulary` is an ENCODED row, so `term_policy` has already been checked
 * against the closed enum; a malformed policy failed integrity before this
 * point rather than reading as "not sealed". The only way past a seal is the
 * owner's trusted `taxonomyOperator` configuration, which no request byte can
 * set and no transport passes.
 *
 * Callers place this AFTER request validity, workspace, the scoped target and
 * every requested reference, and BEFORE any collision, expected-value or
 * already-satisfied decision (the precedence taxonomy-write-v1.md's R6
 * amendment records): a sealed vocabulary answers "sealed", never "that name
 * is taken" or "already done".
 */
export function refuseSealedVocabulary(
  vocabulary: TaxonomyRow,
  options: TaxonomyWriteOptions,
  path: "/vocabulary_id" | "/term_id",
): void {
  if (vocabulary.term_policy === "sealed" && options.taxonomyOperator !== true) {
    failTaxonomy("invalid_request", path);
  }
}
