import { type ApiResult } from "./client";

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
