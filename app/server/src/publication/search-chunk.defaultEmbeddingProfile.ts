/**
 * The baseline embedding profile name: `embed.ts`'s `EMBEDDING_MODEL` default
 * and every indexing test's profile.
 *
 * SEAM (#30 profile registry, being built concurrently): `embedding_profile`
 * is still the free-text name `indexRevisionChunks` stored, and no registry
 * yet says which name is "active". Until one does, a semantic search naming
 * no profile reads the COMPOSED query embedder's own profile
 * (`service.searchKnowledgeSemantic.ts`); this constant is only what the
 * composition names when `EMBEDDING_MODEL` is unset or blank, and the
 * service's fallback when no embedder is composed at all. When the registry
 * lands, both become a read of its default entry.
 */
export const DEFAULT_EMBEDDING_PROFILE = "all-minilm";
