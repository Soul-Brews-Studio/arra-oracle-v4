import { CHUNKER_VERSION, EMBEDDING_DIMENSION, activeEmbeddingProfileId } from "../publication/search-chunk";

export type IndexProfile = {
  readonly chunker_version: string;
  readonly embedding_profile: { readonly name: string; readonly dims: number };
};

/**
 * The chunker and embedding profile a server-side index request uses (R8:
 * index first, embed later by the backfill worker). Operator configuration,
 * never request data: the chunker is the only implemented one, the profile
 * name is the #30 closed registry's active profile id
 * (`search-chunk.profiles.ts`: `ollama/<model>/384/none`, where `<model>` is
 * `EMBEDDING_MODEL` under exactly the rule `embed.ts` (`??`) and `migrate-py`
 * embeddings (`os.environ.get`) use -- unset is `all-minilm`, a set value is
 * taken as-is), and the dimension is the frozen column width.
 *
 * Integration merge (search-embed into the overnight branch): this used to
 * be the bare model name read from the transport's own `env`. The registry
 * refuses every `embedding_profile.name` except its active id, and that id is
 * read from `process.env` once, at import -- so the profile an adapter write
 * asks for is taken from the registry, never re-derived here, or the two
 * could disagree and every index request would be refused.
 */
export function indexProfile(): IndexProfile {
  return Object.freeze({
    chunker_version: CHUNKER_VERSION,
    embedding_profile: Object.freeze({ name: activeEmbeddingProfileId(), dims: EMBEDDING_DIMENSION }),
  });
}
