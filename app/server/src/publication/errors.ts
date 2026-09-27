/**
 * Publication service errors — `arra-publication-error/v1`.
 *
 * Split (Nat style, one exported function per file —
 * docs/overnight/DECISIONS.md, slice style-server-split, 2026-09-28) into
 * errors.constants.ts (vocabulary/class/messages), errors.failPublication.ts
 * and errors.isContractError.ts. Barrel re-exports only, so importers and
 * frozen contract citations do not churn.
 */
export {
  MESSAGES,
  PublicationError,
  PUBLICATION_ERROR_CODES,
  PUBLICATION_ERROR_VERSION,
  type PublicationErrorCode,
  type PublicationErrorShape,
} from "./errors.constants";
export { failPublication } from "./errors.failPublication";
export { isContractError } from "./errors.isContractError";
