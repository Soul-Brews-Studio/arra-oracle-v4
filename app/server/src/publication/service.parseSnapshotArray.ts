import { failPublication } from "./errors";

export function parseSnapshotArray(text: unknown, path: string): Record<string, unknown>[] {
  if (typeof text !== "string") failPublication("integrity_failure", path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failPublication("integrity_failure", path);
  }
  if (!Array.isArray(parsed)) failPublication("integrity_failure", path);
  return parsed as Record<string, unknown>[];
}
