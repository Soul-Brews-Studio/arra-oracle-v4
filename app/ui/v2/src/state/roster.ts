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

const KEY = "arra-ui-v2-roster";

const empty = (): Roster => ({ peers: [], sessions: [] });

/** localStorage holds arbitrary strings from a previous version of this file,
 *  so the shape is re-checked rather than trusted. */
export function loadRoster(workspace: string): Roster {
  try {
    const raw = localStorage.getItem(`${KEY}:${workspace}`);
    if (raw === null) return empty();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty();
    const o = parsed as Record<string, unknown>;
    return { peers: entries(o.peers), sessions: entries(o.sessions) };
  } catch {
    return empty();
  }
}

function entries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  const out: Entry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name === "") continue;
    const state = o.state === "live" || o.state === "missing" ? o.state : "unknown";
    out.push({ name: o.name, state });
  }
  return out;
}

export function saveRoster(workspace: string, roster: Roster): void {
  try {
    localStorage.setItem(`${KEY}:${workspace}`, JSON.stringify(roster));
  } catch {
    /* quota or private mode: the roster is a convenience, never load-bearing */
  }
}

export function addName(list: Entry[], name: string): Entry[] {
  if (name === "" || list.some((e) => e.name === name)) return list;
  return [...list, { name, state: "unknown" }];
}

export function setState(list: Entry[], name: string, state: EntryState): Entry[] {
  return list.map((e) => (e.name === name ? { ...e, state } : e));
}

export function removeName(list: Entry[], name: string): Entry[] {
  return list.filter((e) => e.name !== name);
}
