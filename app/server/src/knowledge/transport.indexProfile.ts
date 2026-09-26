import { CHUNKER_VERSION, EMBEDDING_DIMENSION } from "../publication/search-chunk";

export type IndexProfile = {
  readonly chunker_version: string;
  readonly embedding_profile: { readonly name: string; readonly dims: number };
};

/**
 * The chunker and embedding profile a server-side index request uses (R8:
 * index first, embed later by the backfill worker). Operator configuration,
 * never request data: the chunker is the only implemented one, the profile
 * name is `EMBEDDING_MODEL` with the same default as `embed.ts` and
 * `migrate-py` embeddings (`all-minilm`), and the dimension is the frozen
 * column width.
 */
export function indexProfile(env: NodeJS.ProcessEnv): IndexProfile {
  const name = env.EMBEDDING_MODEL?.trim() || "all-minilm";
  return Object.freeze({ chunker_version: CHUNKER_VERSION, embedding_profile: Object.freeze({ name, dims: EMBEDDING_DIMENSION }) });
}
