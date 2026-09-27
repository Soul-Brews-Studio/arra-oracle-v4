import { failPublication } from "./errors";

export function requireString(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure");
  return value;
}
