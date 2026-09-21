/** Thin fetch wrapper over `POST /api/knowledge/:bank/:method`.
 *
 * Two things this deliberately surfaces rather than smooths over:
 *   - the HTTP STATUS, because the server maps error codes to distinct
 *     statuses (409 conflict, 503 recovery_required, 404 not_found) and
 *     collapsing them would hide the thing most worth seeing
 *   - the raw JSON body, unformatted, because this is a POC for inspecting
 *     real envelopes
 */
export type ApiResult = {
  ok: boolean;
  status: number;
  durationMs: number;
  body: unknown;
  error?: string;
};

export async function callMethod(
  bank: string,
  method: string,
  body: unknown,
  token: string,
): Promise<ApiResult> {
  const started = performance.now();
  try {
    const res = await fetch(
      `/api/knowledge/${encodeURIComponent(bank)}/${encodeURIComponent(method)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON body: show it raw rather than pretending it parsed */
    }
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Math.round(performance.now() - started),
      body: parsed,
    };
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

export async function health(bank: string): Promise<ApiResult> {
  const started = performance.now();
  try {
    // `/health`, NOT `/api/health`. Liveness is the one public route: it
    // answers a constant version/auth-mode with zero storage or policy I/O,
    // and it takes no bank. `/api/health` does not exist and returns a bare
    // 400 from the Host/scope check, which reads like a server fault.
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
