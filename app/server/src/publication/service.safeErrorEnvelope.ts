import { ContractError } from "../contracts/errors";
import { PublicationError } from "./errors";

/**
 * The exact safe wire envelope: version, code, path, message. No `name`.
 *
 * Only ACTUAL ContractError or PublicationError instances serialize as
 * themselves. An object merely shaped like one is unknown and normalizes to a
 * fixed recovery_required -- matching on a `name` property would let arbitrary
 * text out through the boundary.
 */
export function safeErrorEnvelope(error: unknown): Record<string, unknown> {
  if (error instanceof PublicationError || error instanceof ContractError) {
    return error.toJSON() as unknown as Record<string, unknown>;
  }
  return new PublicationError("recovery_required", "").toJSON() as unknown as Record<string, unknown>;
}
