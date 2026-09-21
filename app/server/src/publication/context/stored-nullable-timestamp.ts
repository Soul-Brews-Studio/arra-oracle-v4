import { storedTimestamp } from "./stored-timestamp";

export function storedNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : storedTimestamp(value);
}
