/**
 * #30 closed embedding-profile registry -- constants and the one active
 * profile (overnight R7, `docs/overnight/DECISIONS.md`: "one table holds
 * several embedding profiles, as built. DESIGN gets an amendment.").
 *
 * `search_chunks_v1.embedding_profile` is `utf8 NOT NULL`, and before this
 * registry the value stored there was whatever free-text string a caller's
 * request carried. That let two callers who meant the SAME model disagree on
 * spelling, and left reconcile/freshness/the embed worker with no notion of
 * "the" profile to measure completeness against. `ACTIVE_EMBEDDING_PROFILE`
 * below is that notion; `search-chunk.requireRegisteredEmbeddingProfileName.ts`
 * checks every request against it.
 *
 * R7 is a statement about the PHYSICAL SCHEMA (one table can hold rows from
 * more than one profile), not a promise that this registry accepts more than
 * one name: rows written under a retired id are never deleted, but a REQUEST
 * naming anything other than the active id is refused at the boundary.
 *
 * R20 (the model digest): the digest is part of the profile's identity, but
 * it is NOT part of `profile_id`. `profile_id` is the string every chunk row
 * stores, and rows are indexed BEFORE anything is embedded ("index first,
 * embed later") -- an id that depended on a digest measurement would change
 * the moment the first measurement arrived, orphaning every row indexed
 * before it (measured by the verifier: `@unmeasured` became `@1b226e2802db`
 * across one reboot). So `profile_id` is pure configuration, fixed for the
 * life of the process, and the digest half of the identity is pinned per
 * dataset by the first embed run that writes a vector
 * (`search-chunk.writeEmbeddingPin.ts`) and enforced on every later run
 * (`service.embedPendingChunks.ts`). A different digest is a different
 * model: that run fails closed, it never writes into this profile.
 */

/** Frozen by the physical column type: `embedding` is
 *  `fixed_size_list<float32?>[384]`. A profile declaring any other dimension
 *  cannot be stored, so `embeddingProfile()` refuses one before a caller
 *  ever reaches the writer. */
export const EMBEDDING_DIMENSION = 384;

/**
 * The SAME env var and default `embed.ts` resolves its Ollama model from
 * (fix round 1: this was the bare literal `"all-minilm"`, so an operator who
 * set `EMBEDDING_MODEL` embedded with one model while every row claimed
 * another). A plain string read, no network, so it is as safe at import as
 * `storage.ts`'s own `ARRA_DATA_DIR`.
 */
export const ACTIVE_EMBEDDING_MODEL_NAME = process.env.EMBEDDING_MODEL ?? "all-minilm";

/**
 * How the embedded text is built from a revision, versioned alongside
 * `CHUNKER_VERSION` (`search-chunk.chunkerVersion.ts`): matches
 * `indexRevisionChunks.ts`'s own `${title}\n\nbody` join exactly. Part of the
 * profile because a different join changes what the model saw even for
 * byte-identical title/body.
 */
export const INPUT_RULE = "chunker/v1:title\n\nbody";

export type EmbeddingProfile = {
  readonly profile_id: string;
  readonly provider: "ollama";
  readonly model: string;
  readonly dims: number;
  /** MEASURED, not assumed: `embed.ts` stores exactly what Ollama's
   *  `POST /api/embed` returns; nothing here normalizes it. Adding a
   *  normalization step means changing this, which changes `profile_id`. */
  readonly normalization: "none" | "l2";
  /** all-minilm takes no instruction prefix; both are empty ON PURPOSE so a
   *  future profile that needs one has the field already. */
  readonly document_prefix: string;
  readonly query_prefix: string;
  readonly input_rule: string;
};

/** The one closed profile new writes target. Pure configuration: nothing
 *  in it is measured, so nothing can change it after import (R20). */
export const ACTIVE_EMBEDDING_PROFILE: EmbeddingProfile = Object.freeze({
  profile_id: `ollama/${ACTIVE_EMBEDDING_MODEL_NAME}/${EMBEDDING_DIMENSION}/none`,
  provider: "ollama",
  model: ACTIVE_EMBEDDING_MODEL_NAME,
  dims: EMBEDDING_DIMENSION,
  normalization: "none",
  document_prefix: "",
  query_prefix: "",
  input_rule: INPUT_RULE,
});
