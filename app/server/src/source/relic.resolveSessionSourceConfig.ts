import type { RelicAdapterConfig } from "./relic.types";
import type { SessionSourceStatus } from "./session-source.types";
import { createRelicSessionSource } from "./relic.createRelicSessionSource";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Trusted CONFIGURATION only -- read once by the composition root, never by
 * a request handler (analysis-28.json Unit D: "It must not be
 * request-selectable"). Pure: no spawn, no filesystem check, no import of
 * the SDK. `ARRA_SESSION_SOURCE=relic` opts in; anything else (including
 * unset) is the explicit "not configured" degrade state SPEC.md section
 * 14.6 requires -- never a thrown error, never a silently-empty adapter.
 *
 * `ARRA_RELIC_BIN` has NO baked-in default: a specific operator's home
 * directory path (`/Users/…/.bun/bin/relic`) must never be a shipped
 * fallback for every other checkout of this repo. Opting in without naming
 * the binary is "not configured", the same as not opting in at all.
 */
export function resolveSessionSourceConfig(
  env: Readonly<Record<string, string | undefined>>,
): SessionSourceStatus {
  const kind = env.ARRA_SESSION_SOURCE ?? "";
  if (kind === "") return { configured: false, reason: "ARRA_SESSION_SOURCE is not set" };
  if (kind !== "relic") return { configured: false, reason: `unknown ARRA_SESSION_SOURCE "${kind}"` };

  const binPath = env.ARRA_RELIC_BIN ?? "";
  if (binPath === "") return { configured: false, reason: "ARRA_SESSION_SOURCE=relic but ARRA_RELIC_BIN is not set" };

  const timeoutMs = positiveIntOr(env.ARRA_RELIC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = positiveIntOr(env.ARRA_RELIC_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
  const config: RelicAdapterConfig = { binPath, timeoutMs, maxOutputBytes };
  return { configured: true, source: createRelicSessionSource(config) };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
