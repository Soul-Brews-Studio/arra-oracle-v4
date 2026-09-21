/** All server state for the v2 memory browser, in one hook.
 *
 * The components are deliberately presentational -- they take data and
 * callbacks and fetch nothing -- so every request in this UI is issued from
 * here. That keeps the "what happens when you click" story in a single file
 * instead of spread across a dozen components, which is the only reason a POC
 * this small can stay readable.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Bank,
  type ChatAnswer,
  type ContextResult,
  type MessageRow,
  appendMessage,
  answerChat,
  asError,
  getContext,
  getPeer,
  getSession,
  joinSession,
  listMessages,
  registerPeer,
  registerSession,
} from "../api/memory";
import { type ApiResult } from "../api/client";
import { type Roster, addName, loadRoster, removeName, saveRoster, setState } from "./roster";

/** One place to turn any failed ApiResult into display text. The error
 *  envelope's `code` is the useful part; the HTTP status alone is not, because
 *  several distinct refusals share one status. */
function describe(result: ApiResult): string {
  if (result.error !== undefined) return result.error;
  const envelope = asError(result.body);
  if (envelope !== null) {
    return envelope.pointer !== undefined && envelope.pointer !== ""
      ? `${envelope.code} at ${envelope.pointer}`
      : String(envelope.code);
  }
  return `HTTP ${result.status}`;
}

/** `listMessages` answers `{ rows, next_after_seq }` -- NOT `{ items }`.
 *  `getContext` answers `{ items, coverage, excluded }`. The two read paths
 *  use different envelope keys, and reading the wrong one fails silently as
 *  an empty transcript against a server that returned five messages. */
function rows(body: unknown): MessageRow[] {
  const value = (body as { rows?: unknown })?.rows;
  return Array.isArray(value) ? (value as MessageRow[]) : [];
}

export function useMemory() {
  const [bank, setBank] = useState("default");
  const [workspace, setWorkspace] = useState("default");
  const [token, setToken] = useState("");
  const b: Bank = useMemo(() => ({ bank, token, workspace }), [bank, token, workspace]);

  const [roster, setRoster] = useState<Roster>(() => loadRoster("default"));
  const [peer, setPeer] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const [context, setContext] = useState<ContextResult | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);

  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  // The roster is per-workspace: names in one workspace mean nothing in
  // another, and carrying them across would show rows that cannot exist.
  useEffect(() => {
    setRoster(loadRoster(workspace));
    setPeer(null);
    setSession(null);
  }, [workspace]);

  useEffect(() => {
    saveRoster(workspace, roster);
  }, [workspace, roster]);

  /** Verify one bookmark against the server and record the verdict. A refusal
   *  is an ANSWER here, not an error: `invalid_reference` means the row is
   *  genuinely absent, which is exactly what the `missing` state records. */
  const verify = useCallback(
    async (kind: "peers" | "sessions", name: string) => {
      const result = kind === "peers" ? await getPeer(b, name) : await getSession(b, name);
      const code = asError(result.body)?.code;
      const verdict = result.ok ? "live" : code === "invalid_reference" ? "missing" : "unknown";
      setRoster((r) => ({ ...r, [kind]: setState(r[kind], name, verdict) }));
    },
    [b],
  );

  const verifyAll = useCallback(async () => {
    setBusy(true);
    const current = loadRoster(workspace);
    await Promise.all([
      ...current.peers.map((e) => verify("peers", e.name)),
      ...current.sessions.map((e) => verify("sessions", e.name)),
    ]);
    setBusy(false);
  }, [workspace, verify]);

  const refreshMessages = useCallback(async () => {
    if (session === null) {
      setMessages([]);
      return;
    }
    setLoadingMessages(true);
    setMessageError(null);
    const result = await listMessages(b, session, 50, null);
    setLoadingMessages(false);
    if (!result.ok) {
      setMessages([]);
      setMessageError(describe(result));
      return;
    }
    setMessages(rows(result.body));
  }, [b, session]);

  useEffect(() => {
    void refreshMessages();
  }, [refreshMessages]);

  const refreshContext = useCallback(async () => {
    if (peer === null || session === null) {
      setContext(null);
      return;
    }
    setLoadingContext(true);
    setContextError(null);
    const result = await getContext(b, peer, session, 20);
    setLoadingContext(false);
    if (!result.ok) {
      setContext(null);
      setContextError(describe(result));
      return;
    }
    setContext(result.body as ContextResult);
  }, [b, peer, session]);

  const actions = {
    addPeer: (name: string) => {
      setRoster((r) => ({ ...r, peers: addName(r.peers, name) }));
      void verify("peers", name);
    },
    addSession: (name: string) => {
      setRoster((r) => ({ ...r, sessions: addName(r.sessions, name) }));
      void verify("sessions", name);
    },
    removePeer: (name: string) => setRoster((r) => ({ ...r, peers: removeName(r.peers, name) })),
    removeSession: (name: string) => setRoster((r) => ({ ...r, sessions: removeName(r.sessions, name) })),
    registerPeer: async (name: string) => {
      setBusy(true);
      await registerPeer(b, name);
      await verify("peers", name);
      setBusy(false);
    },
    registerSession: async (name: string) => {
      setBusy(true);
      await registerSession(b, name);
      await verify("sessions", name);
      setBusy(false);
    },
    // Membership is not cosmetic: `getContext` refuses a peer that is not a
    // CURRENT member of the session, so joining is a prerequisite for the
    // whole right-hand column, not a convenience.
    join: async (sessionName: string) => {
      if (peer === null) return;
      setBusy(true);
      const result = await joinSession(b, sessionName, peer);
      setBusy(false);
      if (!result.ok) setMessageError(describe(result));
      await refreshContext();
    },
    send: async (peerName: string, role: string | null, content: string) => {
      if (session === null) return;
      setSending(true);
      const result = await appendMessage(b, session, peerName, content, role);
      setSending(false);
      if (!result.ok) {
        setMessageError(describe(result));
        return;
      }
      await refreshMessages();
    },
    ask: async (question: string, maxItems: number) => {
      if (peer === null || session === null) return;
      setAsking(true);
      setAskError(null);
      const result = await answerChat(b, peer, session, question, maxItems);
      setAsking(false);
      if (!result.ok) {
        setAnswer(null);
        setAskError(describe(result));
        return;
      }
      setAnswer(result.body as ChatAnswer);
    },
    refreshMessages,
    refreshContext,
    verifyAll,
  };

  return {
    bank, setBank, workspace, setWorkspace, token, setToken,
    roster, peer, setPeer, session, setSession, busy,
    messages, loadingMessages, messageError, sending,
    context, loadingContext, contextError,
    answer, asking, askError,
    actions,
  };
}
