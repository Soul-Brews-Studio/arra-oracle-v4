import { ACTIVE_EMBEDDING_MODEL_NAME } from "./search-chunk.profiles";

/**
 * The measured shape of an Ollama model digest: 64 lowercase hex
 * characters (sha256). Anything else is not a measurement. This is also
 * what makes it safe for `embedding_profile_mismatch` to NAME a digest in
 * its envelope: a value that passed this pattern cannot carry prose, a
 * path or an SDK internal (`errors.ts`'s reason for fixed messages).
 */
export const MODEL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Probe the installed `model`'s digest. Never throws: an unreachable,
 * erroring, hung (once `signal` fires) or unrecognisable answer is `null`,
 * "unmeasured". This is the production digest probe `composition.ts` wires
 * into `embedPendingChunks` (R20); it is called there before every run,
 * never at boot.
 *
 * `url` and `model` default to the SAME env vars and defaults `embed.ts`
 * uses (`OLLAMA_URL`, `EMBEDDING_MODEL`), so the digest measured is the
 * digest of the model that actually embeds.
 *
 * MEASURED 2026-09-26 on m5 against a real local Ollama serving
 * `all-minilm`: `POST /api/show` has NO `digest` field (top-level keys:
 * `license`, `modelfile`, `parameters`, `template`, `details`, `model_info`,
 * `capabilities`, `modified_at`), although the brief and R20 both name that
 * endpoint. `GET /api/tags` does carry one per installed model, in
 * `models[].digest` (`all-minilm` was
 * `1b226e2802dbb772b5fc32a58f103ca1804ef7501331012de126ab22f67475ef` that
 * day). This reads `/api/tags` because that is where the fact lives.
 */
export async function fetchOllamaModelDigest(
  options: { url?: string; model?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  const url = options.url ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  const model = options.model ?? ACTIVE_EMBEDDING_MODEL_NAME;
  const names = new Set([model, `${model}:latest`]);
  try {
    const res = await fetch(`${url}/api/tags`, { signal: options.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: unknown };
    if (!Array.isArray(json.models)) return null;
    const match = json.models.find((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const { name, model: tag } = entry as { name?: unknown; model?: unknown };
      return names.has(name as string) || names.has(tag as string);
    }) as { digest?: unknown } | undefined;
    const digest = match?.digest;
    return typeof digest === "string" && MODEL_DIGEST_PATTERN.test(digest) ? digest : null;
  } catch {
    return null;
  }
}
