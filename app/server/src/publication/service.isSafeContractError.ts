import { ContractError } from "../contracts/errors";
import { PublicationError } from "./errors";
import { TaxonomyError } from "./taxonomy";

/**
 * Is this an error WE deliberately raised, rather than an unknown failure?
 *
 * Exact types only. Matching on a `name` or `code` property would let any
 * object shaped like an error escape normalization.
 */
export function isSafeContractError(error: unknown): boolean {
  // `instanceof` against the ACTUAL classes.
  //
  // The protected `isContractError` helper matches on `name` alone, which is
  // duck typing: measured, isContractError({name:"ContractError"}) is true.
  // Using it here would let any object shaped like a contract error escape
  // normalization and carry its raw text out through the boundary. The
  // protected helper is left untouched -- it has its own callers and its own
  // contract; it is simply the wrong tool for a trust decision.
  return (
    error instanceof PublicationError ||
    error instanceof TaxonomyError ||
    error instanceof ContractError
  );
}
