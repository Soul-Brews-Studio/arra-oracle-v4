import { storedNanoid } from "./storedNanoid";

export function storedNullableNanoid(value: unknown): string | null {
  if (value === null) return null;
  return storedNanoid(value);
}
