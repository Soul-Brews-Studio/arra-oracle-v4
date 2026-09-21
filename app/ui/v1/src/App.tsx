import { useState } from "react";
import { Header } from "./components/Header";
import { MethodList } from "./components/MethodList";
import { RequestPanel } from "./components/RequestPanel";
import { ResponsePanel } from "./components/ResponsePanel";
import { NarrowBanner } from "./components/NarrowBanner";
import { callMethod, health, type ApiResult } from "./api/client";
import { sampleBody } from "./api/samples";
import type { Method } from "./api/methods";

export function App() {
  const [bank, setBank] = useState("default");
  const [token, setToken] = useState("");
  const [filter, setFilter] = useState("");
  const [method, setMethod] = useState<Method | null>(null);
  const [body, setBody] = useState("");
  const [result, setResult] = useState<ApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [healthStatus, setHealthStatus] = useState<number | null>(null);

  const select = (m: Method) => {
    setMethod(m);
    setBody(sampleBody(m.name, bank));
    setResult(null);
  };

  const send = async () => {
    if (!method) return;
    setBusy(true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      setResult({
        ok: false,
        status: 0,
        durationMs: 0,
        body: null,
        error: `request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      setBusy(false);
      return;
    }
    setResult(await callMethod(bank, method.name, parsed, token));
    setBusy(false);
  };

  const ping = async () => setHealthStatus((await health(bank)).status);

  return (
    <div className="flex h-screen flex-col bg-ink text-slate-100">
      <Header
        bank={bank}
        token={token}
        onBank={setBank}
        onToken={setToken}
        onPing={ping}
        healthStatus={healthStatus}
      />
      <NarrowBanner />
      <div className="flex min-h-0 flex-1">
        <MethodList selected={method?.name ?? ""} onSelect={select} filter={filter} onFilter={setFilter} />
        <div className="flex min-h-0 flex-1">
          <RequestPanel method={method} body={body} onBody={setBody} onSend={send} busy={busy} />
          <ResponsePanel result={result} />
        </div>
      </div>
    </div>
  );
}
