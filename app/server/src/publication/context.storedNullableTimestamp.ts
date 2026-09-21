import { storedTimestamp } from "./context.storedTimestamp";

export function storedNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : storedTimestamp(value);
}
