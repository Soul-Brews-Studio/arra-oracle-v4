import { MODEL_DIGEST_PATTERN } from "./search-chunk.fetchOllamaModelDigest";
import { type DigestProbeFn } from "./search-chunk.types";
import { LAST_MEASURED_MODEL_DIGESTS } from "./service.lastMeasuredModelDigests";

/**
 * Bound on one digest probe. Read at import like `ARRA_EMBED_TIMEOUT_MS`,
 * with the same guard: anything that is not a finite positive number (an
 * empty string reads as `Number("") === 0`) falls back to the default.
 */
const DIGEST_PROBE_TIMEOUT_MS = ((): number => {
  const raw = Number(process.env.ARRA_EMBED_DIGEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
})();

/**
 * R20: measure the serving model's digest for one embed run. Never throws
 * and never hangs: no probe configured, a rejection, the timeout (enforced
 * here by a timer, never by trusting the probe to honour `signal`) or an
 * answer outside `MODEL_DIGEST_PATTERN` are all `null`, "unmeasured".
 * Every result, `null` included, is recorded as this dataset's
 * `last_measured` for `getSearchFreshness`.
 */
export async function measureModelDigest(datasetRoot: string, probe: DigestProbeFn | undefined): Promise<string | null> {
  let digest: string | null = null;
  if (probe !== undefined) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DIGEST_PROBE_TIMEOUT_MS);
    });
    try {
      const answer = await Promise.race([probe(controller.signal).catch(() => null), timedOut]);
      digest = typeof answer === "string" && MODEL_DIGEST_PATTERN.test(answer) ? answer : null;
    } catch {
      digest = null;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  LAST_MEASURED_MODEL_DIGESTS.set(datasetRoot, digest);
  return digest;
}
