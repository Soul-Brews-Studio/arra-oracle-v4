import { storedMillisTimestamp } from "./storedMillisTimestamp";

export function storedNullableMillisTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return storedMillisTimestamp(value);
}
