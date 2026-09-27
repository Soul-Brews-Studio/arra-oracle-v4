import { type Entry, type Roster } from "./roster";

const KEY = "arra-ui-v2-roster";

const empty = (): Roster => ({ peers: [], sessions: [] });

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
