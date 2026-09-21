import { failPublication } from "./errors";

export function storedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") failPublication("integrity_failure");
  return value;
}
