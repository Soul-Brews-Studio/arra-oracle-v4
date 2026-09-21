import { requireClosedObject, type Tokens } from "../../contracts/common";
import { fail } from "../../contracts/errors";
import type { JcsValue } from "../../contracts/jcs";
import { name } from "./name";
import type { EmbeddingProfileRequest } from "./types";

/** The physical embedding dimension. Frozen by the column type: `embedding`
 *  is `fixed_size_list<float32?>[384]` -- a profile declaring any other
 *  dimension cannot be stored, so it is refused here, at the boundary,
 *  before a caller ever reaches the writer. */
export const EMBEDDING_DIMENSION = 384;

const EMBEDDING_PROFILE_KEYS = ["name", "dims"] as const;

/**
 * `dims` is validated and then DROPPED: only `name` becomes the stored
 * `embedding_profile` text. The frozen dimension is a fact about the ONE
 * physical column, not a per-row value the schema has anywhere to hold.
 */
export function embeddingProfile(value: JcsValue | undefined, tokens: Tokens): EmbeddingProfileRequest {
  const object = requireClosedObject(value ?? null, EMBEDDING_PROFILE_KEYS, tokens);
  const profileName = name(object.get("name"), [...tokens, "name"]);
  const rawDims = object.get("dims");
  if (typeof rawDims !== "number" || !Number.isInteger(rawDims)) {
    fail("invalid_type", [...tokens, "dims"], "expected integer");
  }
  if (rawDims !== EMBEDDING_DIMENSION) {
    fail(
      "invalid_value",
      [...tokens, "dims"],
      `embedding dimension is frozen at ${EMBEDDING_DIMENSION}`,
    );
  }
  return { name: profileName, dims: rawDims };
}
