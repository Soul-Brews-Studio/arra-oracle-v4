import { type Entry, type EntryState } from "./roster";

export function setState(list: Entry[], name: string, state: EntryState): Entry[] {
  return list.map((e) => (e.name === name ? { ...e, state } : e));
}
