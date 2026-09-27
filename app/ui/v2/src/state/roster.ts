/** A LOCAL list of peer and session names, persisted in localStorage.
 *
 * Honcho's dashboard opens on a sidebar of every peer and session in the
 * workspace. This one cannot: the knowledge registry exposes `getPeer` and
 * `getSession` -- lookups by exact name -- and no enumeration endpoint at
 * all. That is a deliberate server-side property, not an oversight to route
 * around, so this UI does not pretend otherwise.
 *
 * What the roster IS: a bookmark list. What it is NOT: a source of truth. A
 * name sitting here means "someone typed this into this browser", nothing
 * more. Every entry is re-verified against the server on load, and its
 * `state` records the answer:
 *
 *   "live"     -- the server returned the row
 *   "missing"  -- the server refused with `invalid_reference`
 *   "unknown"  -- not checked yet, or the check itself failed
 *
 * Showing a stale bookmark as though it were a real row is the one failure
 * mode this file exists to prevent; `missing` entries stay VISIBLE and marked
 * rather than being silently dropped, because a name you saved and the server
 * does not have is information worth seeing.
 */
export type EntryState = "live" | "missing" | "unknown";

export type Entry = { name: string; state: EntryState };

export type Roster = { peers: Entry[]; sessions: Entry[] };

// loadRoster / saveRoster / addName / setState / removeName moved out
// (style-ui-split, docs/overnight/DECISIONS.md): each lives in its own file
// named after itself. Re-exported here so importers (`components/*.tsx`,
// `state/useRoster.ts`) do not churn.
export { loadRoster } from "./roster.loadRoster";
export { saveRoster } from "./roster.saveRoster";
export { addName } from "./roster.addName";
export { setState } from "./roster.setState";
export { removeName } from "./roster.removeName";
