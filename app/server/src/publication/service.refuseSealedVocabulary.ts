import { failTaxonomy } from "./taxonomy";
import { type TaxonomyRow, type TaxonomyWriteOptions } from "./service.types";

/**
 * R6 (#27): a sealed vocabulary is sealed on every transport.
 *
 * `vocabulary.term_policy` has already been checked against the closed enum:
 * an ENCODED stored row (a malformed policy failed integrity before this
 * point rather than reading as "not sealed"), or, for `createVocabulary`, the
 * parsed request. The only way past a seal is the owner's trusted
 * `taxonomyOperator` configuration, which no request byte can set and no
 * transport passes.
 *
 * `path` is the pointer the refusal names: `/vocabulary_id` (createTerm),
 * `/term_id` (rename, retire, reparent), `/term_policy` (createVocabulary)
 * or the manifest pointer of the term a seed would append.
 *
 * Callers place this AFTER request validity, workspace, the scoped target and
 * every requested reference, and BEFORE any collision, expected-value or
 * already-satisfied decision (the precedence taxonomy-write-v1.md's R6
 * amendment records): a sealed vocabulary answers "sealed", never "that name
 * is taken" or "already done". The seed is the one exception, and the
 * amendment says why: its manifest conflicts are checked first.
 */
export function refuseSealedVocabulary(
  vocabulary: TaxonomyRow,
  options: TaxonomyWriteOptions,
  path: string,
): void {
  if (vocabulary.term_policy === "sealed" && options.taxonomyOperator !== true) {
    failTaxonomy("invalid_request", path);
  }
}
