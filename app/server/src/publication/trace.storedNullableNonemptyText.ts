import { storedNonemptyText } from "./trace.storedNonemptyText";

export function storedNullableNonemptyText(value: unknown): string | null {
  if (value === null) return null;
  return storedNonemptyText(value);
}
