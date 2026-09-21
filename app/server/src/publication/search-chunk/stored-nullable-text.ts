import { storedText } from "./stored-text";

export function storedNullableText(value: unknown): string | null {
  if (value === null) return null;
  return storedText(value);
}
