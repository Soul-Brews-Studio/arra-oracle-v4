import { type Entry } from "./roster";

export function addName(list: Entry[], name: string): Entry[] {
  if (name === "" || list.some((e) => e.name === name)) return list;
  return [...list, { name, state: "unknown" }];
}
