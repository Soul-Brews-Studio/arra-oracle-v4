import { failPublication } from "./errors";
import { NANOID21 } from "./service.constants";

export function requireNodeId(value: unknown, path: string): string {
  if (typeof value !== "string" || !NANOID21.test(value)) failPublication("invalid_request", path);
  return value;
}
