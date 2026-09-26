import type { Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import { activeEmbeddingProfileId } from "./search-chunk.activeEmbeddingProfileId";

/**
 * Reject any `embedding_profile` name that is not the active id. Shared by
 * `search-chunk.embeddingProfile.ts` (the `indexRevisionChunks` request
 * object) and `search-chunk.parseListChunks.ts` (a bare string field): both
 * name the SAME registry, so both call through here.
 */
export function requireRegisteredEmbeddingProfileName(value: string, tokens: Tokens): string {
  const activeId = activeEmbeddingProfileId();
  if (value !== activeId) {
    fail(
      "invalid_value",
      tokens,
      `embedding_profile.name is not in the registry; the active profile is ${JSON.stringify(activeId)}`,
    );
  }
  return value;
}
