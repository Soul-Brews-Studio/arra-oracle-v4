import { type Entry } from "./roster";

export function removeName(list: Entry[], name: string): Entry[] {
  return list.filter((e) => e.name !== name);
}
