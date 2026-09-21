import type { EntryState } from "../state/roster";

/** Colours and copy for the three states a roster bookmark can be in. Kept
 *  in one place so PeerRail and SessionRail render the same meaning for the
 *  same word -- "missing" must look identically alarming in both rails. */
const LABEL: Record<EntryState, string> = {
  live: "live -- the server returned this row",
  missing: "missing -- the server refused with invalid_reference",
  unknown: "unknown -- not checked against the server yet",
};

const CLASS: Record<EntryState, string> = {
  live: "bg-accent",
  missing: "bg-[#f0a35e]",
  unknown: "bg-muted",
};

export function StateDot({ state }: { state: EntryState }) {
  return (
    <span
      title={LABEL[state]}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${CLASS[state]}`}
    />
  );
}
