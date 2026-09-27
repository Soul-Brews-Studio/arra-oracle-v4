/** All server state for the v2 memory browser, in one hook.
 *
 * The components are deliberately presentational -- they take data and
 * callbacks and fetch nothing -- so every request in this UI is issued from
 * here. That keeps the "what happens when you click" story in a single file
 * instead of spread across a dozen components, which is the only reason a POC
 * this small can stay readable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useKeyedRead } from "./useKeyedRead";
import { useToken } from "./useToken";

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
 *  `getContext` answers `{ items, coverage, excluded, excluded_omitted }`.
 *  The two read paths use different envelope keys, and reading the wrong
 *  one fails silently as an empty transcript against a server that
 *  returned five messages. */
function rows(body: unknown): MessageRow[] {
  const value = (body as { rows?: unknown })?.rows;
  return Array.isArray(value) ? (value as MessageRow[]) : [];
}

/** What a transcript / context read is FOR: every input that changes its
 *  answer. A read whose key is no longer this is a read for somewhere left. */
const messagesKey = (v: { b: Bank; session: string | null }) =>
  v.session === null ? null : JSON.stringify([v.b.bank, v.b.workspace, v.b.token, v.session]);
const contextKey = (v: { b: Bank; peer: string | null; session: string | null }) =>
  v.peer === null || v.session === null ? null : JSON.stringify([v.b.bank, v.b.workspace, v.b.token, v.peer, v.session]);

export function useMemory() {
  const [bank, setBank] = useState("default");
  const [workspace, setWorkspace] = useState("default");
  // Unlockable from `?token=` / `?key=`; see useToken for why the URL is
  // rewritten the instant it is read.
  const [token, setToken] = useToken();
  const b: Bank = useMemo(() => ({ bank, token, workspace }), [bank, token, workspace]);

  const [roster, setRoster] = useState<Roster>(() => loadRoster("default"));
  const [peer, setPeer] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const [context, setContext] = useState<ContextResult | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);

  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  // Which transcript / context read is current, keyed on the selection it
  // was issued for (useKeyedRead). Switching session (or peer, or bank) while
  // one is in flight must not show one session's messages under another's
  // name -- and `send`/`join` below refresh whatever is on screen when their
  // write lands, not the session they were clicked in (ui-stale round 3).
  const messagesRead = useKeyedRead({ b, session }, messagesKey);
  const contextRead = useKeyedRead({ b, peer, session }, contextKey);
  // `ask`'s answer is exactly as selection-scoped as `getContext` (peer +
  // session): a separate ticket, so asking does not perturb `contextRead`'s
  // own loading flag or land()-clears-pending bookkeeping. `askRead.loading`
  // doubles as the externally-visible `asking` flag below -- it is already
  // keyed on (peer, session), so it reads false the instant the selection
  // moves on, instead of staying true until whichever request is actually
  // in flight (for a selection already left) happens to resolve.
  const askRead = useKeyedRead({ b, peer, session }, contextKey);
  // Fix round (2026-09-27): `askRead.land()` only guards a response still IN
  // FLIGHT when the selection moves on -- it does nothing for an answer/error
  // that already SETTLED while the selection it was asked for was still on
  // screen. Without this, asking in sA, waiting for the answer, then
  // switching to sB left sA's answer (and askError) on screen under sB
  // indefinitely: the literal bug this slice exists to close. Clearing on
  // every key change (not just a fresh land()) closes that gap.
  useEffect(() => {
    setAnswer(null);
    setAskError(null);
    // Keyed on the same inputs as `contextKey`/`askRead` -- a bank, token,
    // peer or session change all mean "this is not the selection sA answered
    // for anymore".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.bank, b.workspace, b.token, peer, session]);
  // Freshness for ACTIONS below (send/join's error, verify's roster write):
  // not a "read" in useKeyedRead's sense, but the same idea -- a result is
  // applied only while the selection it was issued for is still current.
  // `[bank, workspace, token]`, matching every other key in this hook
  // (messagesKey/contextKey): verify is a roster-scoped action, and the
  // roster itself is swapped out wholesale on a WORKSPACE switch (the effect
  // below) -- but a token (or bank) switch alone, same workspace, is just as
  // much "this verdict was asked under credentials already left" (fix round:
  // an old-token 401 could otherwise overwrite a same-workspace verdict
  // fetched under the token now current).
  const bKeyRef = useRef(`${b.bank}:${b.workspace}:${b.token}`);
  bKeyRef.current = `${b.bank}:${b.workspace}:${b.token}`;

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
      const issuedKey = `${b.bank}:${b.workspace}:${b.token}`;
      const result = kind === "peers" ? await getPeer(b, name) : await getSession(b, name);
      // Policy: DROP. A verdict answers "does this name exist in THAT
      // workspace's registry, under THOSE credentials" -- applying it after a
      // workspace, bank or token switch would write a verdict from one
      // registry/credential onto a same-named bookmark under another, which
      // is a name collision, not a real answer about it.
      if (bKeyRef.current !== issuedKey) return;
      const code = asError(result.body)?.code;
      const verdict = result.ok ? "live" : code === "invalid_reference" ? "missing" : "unknown";
      setRoster((r) => ({ ...r, [kind]: setState(r[kind], name, verdict) }));
    },
    [b, workspace],
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
    const t = messagesRead.begin();
    const { b, session } = t.value;
    if (session === null) {
      setMessages([]);
      return;
    }
    setMessageError(null);
    // The transcript pane is the OPERATOR view (no requester): it shows the
    // whole session whichever peer is selected, and needs audit:read (#87 /
    // R3). A token without it gets 403 here, surfaced by `describe` below;
    // the selected peer's own view is the getContext column.
    const result = await listMessages(b, session, 50, null);
    if (!messagesRead.land(t)) return; // a session already left, or a newer read
    if (!result.ok) {
      setMessages([]);
      setMessageError(describe(result));
      return;
    }
    setMessages(rows(result.body));
    // Reads its selection from `messagesRead`, not this closure; the deps
    // only say WHEN a read is due -- a new bank, token or session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, session]);

  useEffect(() => {
    void refreshMessages();
  }, [refreshMessages]);

  const refreshContext = useCallback(async () => {
    const t = contextRead.begin();
    const { b, peer, session } = t.value;
    if (peer === null || session === null) {
      setContext(null);
      return;
    }
    setContextError(null);
    const result = await getContext(b, peer, session, 20);
    if (!contextRead.land(t)) return;
    if (!result.ok) {
      setContext(null);
      setContextError(describe(result));
      return;
    }
    setContext(result.body as ContextResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // `messageError` shows in the Transcript pane for whatever session is
      // ON SCREEN -- read fresh at land time, not the `session` this closure
      // was created for.
      const issuedKey = messagesKey({ b, session });
      setBusy(true);
      const result = await joinSession(b, sessionName, peer);
      setBusy(false);
      // Policy: DROP. A join failure for a session already left has nothing
      // to attribute to on today's single-slot error line.
      if (!result.ok && messagesRead.now.current.key === issuedKey) setMessageError(describe(result));
      await refreshContext();
    },
    send: async (peerName: string, role: string | null, content: string, inReplyTo: string | null = null) => {
      if (session === null) return;
      const issuedKey = messagesKey({ b, session });
      setSending(true);
      const result = await appendMessage(b, session, peerName, content, role, inReplyTo);
      setSending(false);
      if (!result.ok) {
        // Policy: DROP. Painting "your message failed" under a session the
        // user has since switched away from would misattribute a write that
        // happened -- or didn't -- to the wrong context (ui-actions #33).
        if (messagesRead.now.current.key === issuedKey) setMessageError(describe(result));
        return;
      }
      await refreshMessages();
    },
    // Policy: DROP. The dialectic pane has one answer slot, keyed on
    // (peer, session) exactly like `getContext`; showing sA's answer under
    // sB is the literal bug this slice exists to close.
    ask: async (question: string, maxItems: number) => {
      if (peer === null || session === null) return;
      const t = askRead.begin(); // also drives the keyed `asking` flag below
      setAskError(null);
      const result = await answerChat(b, peer, session, question, maxItems);
      const stillCurrent = askRead.land(t);
      if (!stillCurrent) return; // peer/session moved on since the question was asked
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
    messages, loadingMessages: messagesRead.loading, messageError, sending,
    context, loadingContext: contextRead.loading, contextError,
    answer, asking: askRead.loading, askError,
    actions,
  };
}
