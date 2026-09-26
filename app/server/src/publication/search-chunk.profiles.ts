import { fail } from "../contracts/errors";
import type { Tokens } from "../contracts/common";

/**
 * #30 closed embedding-profile registry -- the PURE half (overnight R7,
 * `docs/overnight/DECISIONS.md`: "one table holds several embedding profiles,
 * as built. DESIGN gets an amendment.").
 *
 * `search_chunks_v1.embedding_profile` is `utf8 NOT NULL`, and BEFORE this
 * module the value stored there was whatever free-text string a caller's
 * request happened to carry (`search-chunk.name.ts`'s 256-byte bound, nothing
 * more). That let two callers who meant the SAME model silently disagree on
 * spelling, and let reconcile/freshness/the embed worker have no notion of
 * "the" profile to measure completeness against. This module is that notion:
 * ONE active profile identity, computed here, that every new write is
 * checked against at the request boundary
 * (`requireRegisteredEmbeddingProfileName`, called from
 * `search-chunk.embeddingProfile.ts` and `search-chunk.parseListChunks.ts`).
 *
 * R7 is a statement about the PHYSICAL SCHEMA (one table can hold rows from
 * more than one profile -- true whether or not this registry existed), not a
 * promise that this registry validates more than one name: rows written
 * under a retired or pre-registry profile id are never deleted and stay
 * readable by whatever already-scoped path reaches them directly, but a
 * REQUEST naming anything other than the current active id is refused here,
 * at the boundary, same as every other closed grammar in this split.
 *
 * `EMBEDDING_DIMENSION` lives here rather than in
 * `search-chunk.embeddingProfile.ts` (where it lived before this module
 * existed) because dims is now one field of the profile identity built
 * below, and `embeddingProfile()` needs BOTH that constant and the
 * registry check -- keeping the constant upstream of that dependency avoids
 * the two files importing each other.
 */

/** Frozen by the physical column type: `embedding` is
 *  `fixed_size_list<float32?>[384]`. A profile declaring any other dimension
 *  cannot be stored, so `embeddingProfile()` refuses one before a caller
 *  ever reaches the writer. */
export const EMBEDDING_DIMENSION = 384;

const PROVIDER = "ollama" as const;
const MODEL = "all-minilm";

/**
 * MEASURED, not assumed: `embed.ts`'s `embed()` returns exactly what
 * Ollama's `POST /api/embed` hands back for `all-minilm` -- this server
 * applies no normalization step of its own before the vector is stored.
 * "none" states what the write path actually does today; if a normalization
 * step is ever added, changing this constant is what makes that a recorded
 * profile change instead of a silent one.
 */
const NORMALIZATION: "none" | "l2" = "none";

/** all-minilm takes no instruction-style prefix (unlike the e5/bge/ collections);
 *  both are empty ON PURPOSE, not merely unset, so a future profile that DOES
 *  need one has a field already reserved on this type. */
const DOCUMENT_PREFIX = "";
const QUERY_PREFIX = "";

/**
 * How the embedded text is built from a revision, versioned alongside
 * `CHUNKER_VERSION` (`search-chunk.chunkerVersion.ts`): matches
 * `indexRevisionChunks.ts`'s own `${title}\n\nbody` join exactly. This
 * string is part of the profile's identity because a different join rule
 * changes what the model actually saw even for byte-identical title/body.
 */
export const INPUT_RULE = "chunker/v1:title\n\nbody";

export type EmbeddingProfile = {
  readonly profile_id: string;
  readonly provider: "ollama";
  readonly model: string;
  readonly dims: number;
  readonly normalization: "none" | "l2";
  readonly document_prefix: string;
  readonly query_prefix: string;
  readonly input_rule: string;
};

/**
 * The one module-private singleton, same shape as `mcp/index.ts`'s
 * `configureKnowledgeAccess`: the model digest is a RUNTIME fact this module
 * cannot know at import time. Reading it from `process.env` at import (the
 * `storage.ts` convention) would force every import of this module --
 * including by tests that never touch Ollama -- to have already completed a
 * live network probe before the module could load at all. Recording it
 * explicitly, once, keeps this module importable with no network access and
 * makes the "unmeasured" default an honest one rather than an accident of
 * import order.
 */
let activeModelDigest: string | null = null;

/**
 * Record the currently-measured `all-minilm` digest. Called exactly once by
 * `composition.ts`'s `runStartupIndexWork` at real startup, with the result
 * of `fetchOllamaModelDigest` below, and by tests with a fixed stub value --
 * "do not hard-code a digest you did not measure" (the overnight brief) means
 * a test never invents a plausible-looking hex string as a PRODUCTION
 * constant; a test-local stub passed through this same seam is exactly the
 * sanctioned way to exercise the recording path without a real Ollama.
 */
export function configureActiveEmbeddingModelDigest(digest: string | null): void {
  activeModelDigest = digest;
}

/** Diagnostic/test accessor. Never consulted to decide acceptance -- the
 *  registry check only ever compares against `activeEmbeddingProfileId()`. */
export function getActiveEmbeddingModelDigest(): string | null {
  return activeModelDigest;
}

/** Short digest segment, matching a "first 12 hex characters" convention
 *  used for readability elsewhere: the id's job is stable identity, not
 *  carrying the full digest string. */
function digestSegment(): string {
  return activeModelDigest === null ? "unmeasured" : activeModelDigest.slice(0, 12);
}

/**
 * The one closed profile new writes target. Computed fresh on every call
 * (not cached) so a `configureActiveEmbeddingModelDigest` call -- at startup,
 * or between tests -- is reflected immediately; this is pure arithmetic over
 * a handful of constants, not a measurement worth memoizing.
 */
export function activeEmbeddingProfile(): EmbeddingProfile {
  return {
    profile_id: `${PROVIDER}/${MODEL}@${digestSegment()}/${EMBEDDING_DIMENSION}/${NORMALIZATION}`,
    provider: PROVIDER,
    model: MODEL,
    dims: EMBEDDING_DIMENSION,
    normalization: NORMALIZATION,
    document_prefix: DOCUMENT_PREFIX,
    query_prefix: QUERY_PREFIX,
    input_rule: INPUT_RULE,
  };
}

export function activeEmbeddingProfileId(): string {
  return activeEmbeddingProfile().profile_id;
}

/**
 * Reject any `embedding_profile` name that is not the current active id.
 * Shared by `search-chunk.embeddingProfile.ts` (the `indexRevisionChunks`
 * request object) and `search-chunk.parseListChunks.ts` (a bare string
 * field) -- both name the SAME registry, so both call through here rather
 * than each keeping its own copy of the comparison.
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

/**
 * Best-effort runtime probe of the installed `model`'s digest. Never throws:
 * an unreachable or erroring Ollama returns `null`, the same way
 * `embed.ts`'s own `health()` treats a down embedder as data rather than a
 * crash. This is the ONLY function in this file that performs I/O -- every
 * export above is pure arithmetic over constants and the `activeModelDigest`
 * singleton. `composition.ts` calls this once at startup and records the
 * result with `configureActiveEmbeddingModelDigest`; this function holds no
 * state of its own and this module never calls it itself.
 *
 * MEASURED 2026-09-26 on m5, against a real local Ollama serving
 * `all-minilm` (`curl -X POST 127.0.0.1:11434/api/show -d '{"model":
 * "all-minilm"}'`): the response has NO `digest` field at all (its top-level
 * keys are `license`, `modelfile`, `parameters`, `template`, `details`,
 * `model_info`, `capabilities`, `modified_at`) -- despite that being where
 * the overnight brief said to read it. `GET /api/tags` DOES carry one, per
 * installed model, in its `models[].digest` field (measured the same way:
 * `all-minilm`'s was `1b226e2802dbb772b5fc32a58f103ca1804ef7501331012de126ab22f67475ef`
 * on this host that day). This function reads `/api/tags` and matches on
 * `name`/`model`, not `/api/show`, because that is where the fact
 * genuinely lives -- "measured, not assumed" applies to the API shape too.
 */
export async function fetchOllamaModelDigest(
  options: { url?: string; model?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  const url = options.url ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  const model = options.model ?? MODEL;
  try {
    const res = await fetch(`${url}/api/tags`, { signal: options.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: unknown };
    if (!Array.isArray(json.models)) return null;
    const match = json.models.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        ((entry as { name?: unknown }).name === model || (entry as { model?: unknown }).model === model ||
          (entry as { name?: unknown }).name === `${model}:latest` ||
          (entry as { model?: unknown }).model === `${model}:latest`),
    ) as { digest?: unknown } | undefined;
    return typeof match?.digest === "string" && match.digest.length > 0 ? match.digest : null;
  } catch {
    return null;
  }
}
