/**
 * The embedding profile a semantic search reads when the request names none.
 *
 * SEAM (#30 profile registry, being built concurrently): `embedding_profile`
 * is still the free-text name `indexRevisionChunks` stored, and no registry
 * yet says which name is "active". Until one does, the default is the name
 * the whole codebase already uses for the one baseline model -- `embed.ts`'s
 * `EMBEDDING_MODEL` default and every indexing test's profile. When the
 * registry lands, this constant becomes a read of its default entry; the
 * semantic grammar (`parseSearchKnowledgeSemantic`) is the only reader.
 */
export const DEFAULT_EMBEDDING_PROFILE = "all-minilm";
