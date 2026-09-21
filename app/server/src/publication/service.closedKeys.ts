import { type JcsObject } from "../contracts/jcs";
import { failPublication } from "./errors";

export function closedKeys(o: JcsObject, keys: readonly string[], base: string): void {
  for (const key of keys) {
    if (!o.has(key)) failPublication("invalid_request", `${base}/${key}`);
  }
  for (const key of o.keys()) {
    if (!keys.includes(key)) failPublication("invalid_request", `${base}/${key}`);
  }
}
