import { storedText } from "./search-chunk.storedText";

export function storedNullableText(value: unknown): string | null {
  if (value === null) return null;
  return storedText(value);
}
