import { requireClosedObject, type Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import type { JcsValue } from "../contracts/jcs";
import { name } from "./search-chunk.name";
import { EMBEDDING_DIMENSION } from "./search-chunk.profiles";
import { requireRegisteredEmbeddingProfileName } from "./search-chunk.requireRegisteredEmbeddingProfileName";
import type { EmbeddingProfileRequest } from "./search-chunk.types";

export { EMBEDDING_DIMENSION };

const EMBEDDING_PROFILE_KEYS = ["name", "dims"] as const;

/**
 * `dims` is validated and then DROPPED: only `name` becomes the stored
 * `embedding_profile` text. The frozen dimension is a fact about the ONE
 * physical column, not a per-row value the schema has anywhere to hold.
 *
 * #30 R7: `name` must additionally be the current active profile id
 * (`search-chunk.profiles.ts`'s closed registry) -- a caller naming anything
 * else, including a once-valid but now-retired id, is refused
 * `invalid_value` at `/embedding_profile/name` before the dims check ever
 * runs, matching the request-grammar ordering every other field here uses
 * (name first, since it is what the registry check is about).
 */
export function embeddingProfile(value: JcsValue | undefined, tokens: Tokens): EmbeddingProfileRequest {
  const object = requireClosedObject(value ?? null, EMBEDDING_PROFILE_KEYS, tokens);
  const profileName = requireRegisteredEmbeddingProfileName(
    name(object.get("name"), [...tokens, "name"]),
    [...tokens, "name"],
  );
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
