import { type ApiResult } from "./client";

export async function health(bank: string): Promise<ApiResult> {
  const started = performance.now();
  try {
    // `/health`, NOT `/api/health`. Both exist and they are different
    // routes, which is the trap: `/health` is the public liveness check --
    // constant version and auth-mode, no bank, no token, zero storage or
    // policy I/O. `/api/health?bank=X` is GATED diagnostics and needs a
    // bearer token (verified: 200 with one, 401 without, 400 with no bank).
    // A ping that wants "is the server up" must use the first; calling the
    // second without credentials returns a bare 400 or 401 that reads like
    // a server fault rather than a missing token.
    void bank;
    const res = await fetch(`/health`);
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, durationMs: Math.round(performance.now() - started), body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
