import { type Roster } from "./roster";

const KEY = "arra-ui-v2-roster";

export function saveRoster(workspace: string, roster: Roster): void {
  try {
    localStorage.setItem(`${KEY}:${workspace}`, JSON.stringify(roster));
  } catch {
    /* quota or private mode: the roster is a convenience, never load-bearing */
  }
}
