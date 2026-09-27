import { requireString } from "./rows.requireString";

export function requireNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value);
}
