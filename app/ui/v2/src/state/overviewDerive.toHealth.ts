import { type ApiResult } from "../api/client";
import { type HealthInfo } from "./overviewDerive";

export function toHealth(result: ApiResult): HealthInfo {
  const body = (result.ok && typeof result.body === "object" && result.body !== null
    ? result.body
    : {}) as Record<string, unknown>;
  return {
    ok: result.ok,
    version: typeof body.version === "string" ? body.version : null,
    auth: typeof body.auth === "string" ? body.auth : null,
    durationMs: result.durationMs,
  };
}
