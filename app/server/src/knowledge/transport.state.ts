// Split from transport.ts (style-split4b, 2026-09-28): data-only module identity
// for the constants and types this transport's split files share. No functions
// here -- see transport.<fn>.ts.
import type { TransportRejection } from "../auth/http";
import type { ChatModelFn, ChatSettings } from "../publication/chat";
import { type DigestProbeFn, type EmbedFn } from "../publication/search-chunk.types";
import type { QueryEmbedder } from "../publication/service";
import type { KnowledgeAction, KnowledgeBundle } from "./registry";
import type { IndexProfile } from "./transport.indexProfile";

/** Matches the governed kernel's own request cap exactly (publication/service.ts). */
export const MAX_KNOWLEDGE_REQUEST_BYTES = 1024 * 1024;
export const MAX_KNOWLEDGE_REQUEST_DEPTH = 64;

export type RawBody = { readonly bytes: Uint8Array } | TransportRejection;

export type KnowledgeDatasetConfig = {
  readonly datasetRoot: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * #32 / R9: the chat model and its effective settings, trusted composition
   * input (`composition.ts` builds them from env via `src/chat-model.ts`),
   * never request data. Absent means unconfigured: `answerChat` answers
   * `model_unavailable` and `getChatSettings` answers `{model: null}`.
   */
  readonly chat?: { readonly model?: ChatModelFn; readonly settings: ChatSettings | null };
  /**
   * #30: the trusted query embedder semantic search is composed with
   * (`composition.ts`: local Ollama; tests: a stub), handed to the READER only
   * (`openEvidenceReader(root, {embedder})`), like the chat model above --
   * never a writer option. Absent, or on any embedder failure, means
   * `searchKnowledgeSemantic` answers the closed `model_unavailable` code
   * (overnight R21, aligned with #32 / R9's chat code).
   */
  readonly embedder?: QueryEmbedder;
  /**
   * #30 R8's embed worker DOCUMENT embedder (`embedPendingChunks`), wired by
   * `composition.ts`'s `composeKnowledgeAccess` from `embed.ts`'s Ollama
   * `embed()`. Unlike the query `embedder` above it is a WRITER option:
   * `embedPendingChunks` is a real, durable write of `search_chunks_v1`
   * vectors, so it runs on the one cached writer. Absent (e.g. every existing
   * test's fake config) means `embedPendingChunks` still runs -- content-hash
   * reuse needs no embedder at all -- but any chunk it cannot satisfy that
   * way fails closed with `embedder_unavailable` rather than making a
   * network call this transport was never told about.
   */
  readonly documentEmbedder?: EmbedFn;
  /** #30 R20's model-digest probe, wired by `composeKnowledgeAccess`, a
   *  WRITER option beside `documentEmbedder`. Absent means every
   *  `embedPendingChunks` run is `blocked: "digest_unmeasured"` and writes
   *  nothing -- never a vector without a measured digest. */
  readonly digestProbe?: DigestProbeFn;
};

/**
 * What both transports need from dataset access: one bundle per action. There
 * is deliberately no second, per-request writer here any more (#32 / R9).
 */
export type KnowledgeAccess = {
  /** False only when no dataset root is configured; see `transport.isDatasetConfigured.ts`. */
  readonly datasetConfigured?: boolean;
  /** Absent on test fakes; `mcp/legacy-v3/dispatchLegacyV3.ts` then uses the defaults. */
  readonly indexProfile?: IndexProfile;
  getBundle(action: KnowledgeAction): Promise<KnowledgeBundle>;
};
