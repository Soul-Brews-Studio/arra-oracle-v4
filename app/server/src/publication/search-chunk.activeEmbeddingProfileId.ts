import { ACTIVE_EMBEDDING_PROFILE } from "./search-chunk.profiles";

/** The `embedding_profile` string every new chunk row is written under and
 *  every request is checked against. Fixed for the life of the process: R20
 *  keeps the model digest OUT of it (see `search-chunk.profiles.ts`). */
export function activeEmbeddingProfileId(): string {
  return ACTIVE_EMBEDDING_PROFILE.profile_id;
}
