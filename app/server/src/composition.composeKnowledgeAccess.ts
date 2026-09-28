import { createKnowledgeAccess, type KnowledgeAccess } from "./knowledge/transport";

/**
 * #31 knowledge dataset access, built from environment configuration.
 *
 * `ARRA_KNOWLEDGE_DATASET_ROOT` is optional: an existing deployment that has
 * not adopted the publication/taxonomy/context/evidence dataset yet keeps
 * starting up exactly as before, and every `/api/knowledge/*` route (and
 * every `kb_*` MCP tool) answers a fixed `unsupported_dataset` envelope
 * instead of trying to open a dataset that was never configured. Reads and
 * the writer are still opened lazily inside `createKnowledgeAccess` — this
 * function only decides WHERE, never whether a connection is attempted yet.
 *
 * #32 / R9: the chat model is composed HERE, from env, and handed to the
 * access as trusted configuration -- the only place a model is wired. The
 * model module is imported lazily, like `embed.ts` in `composeService`.
 * `ARRA_CHAT_PROVIDER` unset leaves chat unconfigured (`model_unavailable`);
 * a malformed `ARRA_CHAT_*` throws, and `startup` checks that first. The #30
 * query embedder is composed here the same way, for the same reader.
 *
 * #30 R8 / R20: the embed worker's DOCUMENT embedder and the model-digest
 * probe are composed here too, but for the WRITER: `embedPendingChunks`
 * writes vectors, so it runs on the one cached writer, never the reader.
 * Query and document embedder share one model, the #30 registry's active
 * profile (`search-chunk.profiles.ts`), so a query vector and the chunk
 * vectors it is compared with always come from the same model, stored under
 * the same profile id. Neither embedder nor the probe is called here: boot
 * never probes the model and never pins a digest (R20).
 *
 * app/migrate-py/tests/test_revision_v1.py PUBLICATION_CONSUMERS: this file
 * took over `composition.ts`'s lazy imports of `./publication/search-chunk.profiles`
 * and `./publication/search-chunk.fetchOllamaModelDigest` in the style-split6
 * composition split and is registered there in the same change.
 */
export async function composeKnowledgeAccess(env: NodeJS.ProcessEnv = process.env): Promise<KnowledgeAccess> {
  const datasetRoot = env.ARRA_KNOWLEDGE_DATASET_ROOT;
  const { createChatModel } = await import("./chat-model");
  const chat = createChatModel(env);
  // The registry reads EMBEDDING_MODEL from `process.env` once, at import
  // (like `embed.ts`), so the profile every chunk row is indexed under is
  // fixed for the process; imported lazily here, per this module's header.
  const { ACTIVE_EMBEDDING_PROFILE } = await import("./publication/search-chunk.profiles");
  const embeddingModel = ACTIVE_EMBEDDING_PROFILE.model;
  return createKnowledgeAccess({
    datasetRoot: typeof datasetRoot === "string" && datasetRoot.trim() ? datasetRoot : undefined,
    env,
    chat: { model: chat.model, settings: chat.settings },
    // #30 semantic search: the query embedder is `embed.ts`'s local Ollama
    // client, imported lazily on first use like `composeService`'s raw
    // modules, and handed to the READER only (like the chat model above,
    // never a writer option). Its profile is the #30 registry's active
    // profile id -- the one name `indexRevisionChunks` accepts and stores --
    // and it calls that profile's own model, so the profile a search reports
    // can never differ from the model that embedded its query. (Integration
    // merge: this replaces the retrieval slice's model-name-as-profile seam.)
    embedder: {
      profile: ACTIVE_EMBEDDING_PROFILE.profile_id,
      embed: async (text: string) => (await import("./embed")).embedOne(text, embeddingModel),
    },
    // #30 R8: the embed worker's DOCUMENT embedder, a WRITER option (see
    // above) and named apart from the reader's query `embedder`. The same
    // Ollama call and the same model, lazily imported so merely composing
    // knowledge access cannot trigger `embed.ts`'s own import-time
    // environment reads (this module's own header rule).
    documentEmbedder: (texts, signal) => import("./embed").then((mod) => mod.embed(texts, embeddingModel, signal)),
    // #30 R20: the model-digest probe every `embedPendingChunks` run makes
    // before embedding anything -- `GET /api/tags` on the same OLLAMA_URL and
    // EMBEDDING_MODEL `embed.ts` uses. Called per run, never at boot.
    digestProbe: (signal) =>
      import("./publication/search-chunk.fetchOllamaModelDigest").then((mod) =>
        mod.fetchOllamaModelDigest({ signal }),
      ),
  });
}
