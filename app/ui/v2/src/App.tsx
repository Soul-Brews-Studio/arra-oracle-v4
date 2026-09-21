import { useEffect, useMemo, useState } from "react";
import { ContextPanel } from "./components/ContextPanel";
import { Composer } from "./components/Composer";
import { DialecticPanel } from "./components/DialecticPanel";
import { EmptyState } from "./components/EmptyState";
import { ErrorNote } from "./components/ErrorNote";
import { PeerRail } from "./components/PeerRail";
import { SidebarShell } from "./components/SidebarShell";
import { SessionRail } from "./components/SessionRail";
import { Transcript } from "./components/Transcript";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { KnowledgeView } from "./KnowledgeView";
import { useMemory } from "./state/useMemory";
import { useRoute } from "./state/useRoute";

/** Three columns, matching what the data actually is:
 *
 *   rails      -- WHO and WHERE: peers and sessions (local bookmarks, verified)
 *   transcript -- WHAT WAS SAID: the session's messages, plus an append box
 *   dialectic  -- WHAT CAN BE KNOWN: assembled context and the chat answer
 *
 * The split is Honcho's, because the underlying model is Honcho's. The only
 * structural difference is the rails, which cannot enumerate; see
 * `state/roster.ts` for why that is a server property rather than a gap here.
 */
export function App() {
  const m = useMemory();
  const [health, setHealth] = useState<number | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  // Two halves of one system, and the tab says which you are looking at.
  // `messages` is Honcho's model -- peers, sessions, context, dialectic.
  // `knowledge` is arra-oracle-v3's -- nodes, immutable revisions, a
  // controlled type vocabulary and tags. They share a bank and a workspace
  // and nothing else, which is why they are tabs rather than one screen.
  // View and selection live in the URL, so a refresh restores where you were
  // and Back steps through what you clicked. See state/useRoute.
  const { route, push } = useRoute();
  const view = route.view;
  const setView = (v: "messages" | "knowledge") => push({ view: v });

  // Verify the saved roster once per bank/workspace change: a bookmark that
  // has gone stale should announce itself on arrival, not the first time you
  // click it and get a refusal.
  useEffect(() => {
    void m.actions.verifyAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.bank, m.workspace, m.token]);

  useEffect(() => {
    void m.actions.refreshContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.peer, m.session]);

  // The URL is the source of truth for the selection, not the click handler:
  // that is what makes a pasted link and the Back button behave the same as
  // clicking, instead of only the click path working.
  useEffect(() => {
    if (route.peer !== m.peer) m.setPeer(route.peer);
    if (route.session !== m.session) m.setSession(route.session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.peer, route.session]);

  // The dialectic answer names the exact messages it was allowed to read.
  // Marking those in the transcript is the whole point of showing both at
  // once: you can see what the answer saw, and what it did not.
  const highlighted = useMemo(
    () => new Set(m.answer?.items_used ?? []),
    [m.answer],
  );

  const needBoth =
    m.peer === null && m.session === null
      ? "Pick a peer and a session."
      : m.peer === null
        ? "Pick a peer."
        : m.session === null
          ? "Pick a session."
          : null;

  return (
    <div className="flex h-screen flex-col bg-ink text-slate-200">
      <WorkspaceBar
        bank={m.bank}
        workspace={m.workspace}
        token={m.token}
        onBank={m.setBank}
        onWorkspace={m.setWorkspace}
        onToken={m.setToken}
        onHealth={setHealth}
        healthStatus={health}
      />

      <nav className="flex gap-1 border-b border-edge px-4 py-1.5">
        {(["messages", "knowledge"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            title={
              v === "messages"
                ? "Honcho's model: peers, sessions, messages, assembled context, dialectic"
                : "arra-oracle-v3's model: nodes, immutable revisions, type vocabulary, tags"
            }
            className={`rounded px-2.5 py-1 text-xs ${
              view === v
                ? "bg-accent/15 text-accent"
                : "text-muted hover:text-slate-200"
            }`}
          >
            {v}
          </button>
        ))}
      </nav>

      {view === "knowledge" ? (
        <KnowledgeView
          bank={{ bank: m.bank, token: m.token, workspace: m.workspace }}
          nodeId={route.node}
          onSelectNode={(id) => push({ node: id })}
        />
      ) : (
      <div className="flex min-h-0 flex-1">
        <SidebarShell
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed((v) => !v)}
          peer={m.peer}
          session={m.session}
        >
          <PeerRail
            entries={m.roster.peers}
            selected={m.peer}
            onSelect={(name) => push({ peer: name })}
            onAdd={m.actions.addPeer}
            onRemove={m.actions.removePeer}
            onRegister={(n) => void m.actions.registerPeer(n)}
            busy={m.busy}
          />
          <SessionRail
            entries={m.roster.sessions}
            selected={m.session}
            onSelect={(name) => push({ session: name })}
            onAdd={m.actions.addSession}
            onRemove={m.actions.removeSession}
            onRegister={(n) => void m.actions.registerSession(n)}
            onJoin={(n) => void m.actions.join(n)}
            busy={m.busy}
          />
        </SidebarShell>

        <main className="flex min-w-0 flex-1 flex-col">
          {m.session === null ? (
            <EmptyState
              title="No session selected"
              detail="Add a session name on the left. There is no listing endpoint, so names are bookmarks you keep locally."
            />
          ) : (
            <>
              <Transcript
                messages={m.messages}
                loading={m.loadingMessages}
                error={m.messageError}
                selectedSession={m.session}
                highlighted={highlighted}
                onLoadMore={() => void m.actions.refreshMessages()}
                hasMore={false}
              />
              <Composer
                peerName={m.peer ?? ""}
                onSend={(p, r, c) => void m.actions.send(p, r, c)}
                sending={m.sending}
                disabled={m.session === null}
                disabledReason={m.session === null ? "Pick a session first." : null}
              />
            </>
          )}
        </main>

        <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-l border-edge p-3">
          <DialecticPanel
            onAsk={(q, n) => void m.actions.ask(q, n)}
            answer={m.answer}
            asking={m.asking}
            error={m.askError}
            disabled={needBoth !== null}
            disabledReason={needBoth}
          />
          <ContextPanel
            context={m.context}
            loading={m.loadingContext}
            error={m.contextError}
            onRefresh={() => void m.actions.refreshContext()}
          />
          {m.messageError !== null && (
            <ErrorNote error={{ code: "request failed", message: m.messageError }} />
          )}
        </aside>
      </div>
      )}
    </div>
  );
}
