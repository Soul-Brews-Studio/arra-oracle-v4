import { storedText } from "./trace.storedText";

export function storedNullableText(value: unknown): string | null {
  if (value === null) return null;
  return storedText(value);
}
