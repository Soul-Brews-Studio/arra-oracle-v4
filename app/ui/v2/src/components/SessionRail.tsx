import { AddNameForm } from "./AddNameForm";
import { RosterEntryRow } from "./RosterEntryRow";
import type { Entry } from "../state/roster";

/** The session roster. Shaped like PeerRail, plus `join`: getContext only
 *  returns rows for a peer that is a CURRENT member of the session, so
 *  "session exists" (live) and "my selected peer can see it" are different
 *  facts -- join is how you turn the first into the second. */
export function SessionRail({
  entries,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onRegister,
  onJoin,
  busy,
}: {
  entries: Entry[];
  selected: string | null;
  onSelect: (name: string) => void;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onRegister: (name: string) => void;
  onJoin: (sessionName: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
        sessions
      </div>
      <AddNameForm placeholder="session name…" onSubmit={onAdd} />
      <div className="flex flex-col gap-0.5 px-1">
        {entries.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted">no sessions bookmarked yet</div>
        )}
        {entries.map((entry) => (
          <RosterEntryRow
            key={entry.name}
            entry={entry}
            selected={selected === entry.name}
            onSelect={() => onSelect(entry.name)}
            onRemove={() => onRemove(entry.name)}
            onRegister={() => onRegister(entry.name)}
            registerLabel="register"
            busy={busy}
            extra={
              <button
                onClick={() => onJoin(entry.name)}
                disabled={busy || entry.state !== "live"}
                title="join the selected peer to this session"
                className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted hover:border-accent/40 hover:text-accent disabled:opacity-40"
              >
                join
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}
