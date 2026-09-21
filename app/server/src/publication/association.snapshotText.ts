import { failPublication } from "./errors";

export function snapshotText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) failPublication("integrity_failure");
  return value;
}
