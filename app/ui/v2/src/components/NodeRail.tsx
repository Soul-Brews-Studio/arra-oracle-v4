import { AddNameForm } from "./AddNameForm";
import { RosterEntryRow } from "./RosterEntryRow";
import type { Entry } from "../state/roster";

/** The node bookmark rail -- same shape as PeerRail, but nanoid21 node ids
 *  are opaque to a human, so the row shows a TITLE when one is known and
 *  falls back to the truncated id. `titles` is keyed by node_id and filled
 *  in by whichever fetch already loaded that node's accepted head; this
 *  component never fetches it itself.
 *
 *  "new" mints a fresh id client-side (this tier has no allocator, see
 *  knowledge.ts trap 4) and hands it to the caller to start a draft -- it
 *  does not add the id to the roster itself, since an unpublished node is
 *  not yet a bookmark worth keeping if the draft is abandoned. */
export function NodeRail({
  entries,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onNew,
  busy,
  titles,
}: {
  entries: Entry[];
  selected: string | null;
  onSelect: (nodeId: string) => void;
  onAdd: (nodeId: string) => void;
  onRemove: (nodeId: string) => void;
  onNew: () => void;
  busy: boolean;
  titles?: Record<string, string>;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-2 pb-1 pt-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">nodes</span>
        <button
          onClick={onNew}
          className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10"
        >
          new
        </button>
      </div>
      <AddNameForm placeholder="node id…" onSubmit={onAdd} />
      <div className="flex flex-col gap-0.5 px-1">
        {entries.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted">no nodes bookmarked yet</div>
        )}
        {entries.map((entry) => (
          <RosterEntryRow
            key={entry.name}
            entry={{ ...entry, name: titles?.[entry.name] ?? truncate(entry.name) }}
            selected={selected === entry.name}
            onSelect={() => onSelect(entry.name)}
            onRemove={() => onRemove(entry.name)}
            onRegister={() => {}}
            registerLabel=""
            busy={busy}
          />
        ))}
      </div>
    </div>
  );
}

/** Nanoid21 ids are unreadable in full; 8 chars is enough to tell two apart
 *  by eye without the row wrapping. */
function truncate(nodeId: string): string {
  return nodeId.length <= 10 ? nodeId : `${nodeId.slice(0, 8)}…`;
}
