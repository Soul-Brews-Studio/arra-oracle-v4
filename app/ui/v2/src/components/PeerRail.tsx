import { AddNameForm } from "./AddNameForm";
import { RosterEntryRow } from "./RosterEntryRow";
import type { Entry } from "../state/roster";

/** The peer roster. This is a bookmark list, not truth -- see roster.ts --
 *  so a `missing` peer stays in the list rather than being dropped; the row
 *  itself carries the state dot that makes the difference visible. */
export function PeerRail({
  entries,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onRegister,
  busy,
}: {
  entries: Entry[];
  selected: string | null;
  onSelect: (name: string) => void;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onRegister: (name: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
        peers
      </div>
      <AddNameForm placeholder="peer name…" onSubmit={onAdd} />
      <div className="flex flex-col gap-0.5 px-1">
        {entries.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted">no peers bookmarked yet</div>
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
          />
        ))}
      </div>
    </div>
  );
}
