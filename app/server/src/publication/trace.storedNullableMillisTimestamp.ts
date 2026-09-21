import { storedMillisTimestamp } from "./trace.storedMillisTimestamp";

export function storedNullableMillisTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return storedMillisTimestamp(value);
}
