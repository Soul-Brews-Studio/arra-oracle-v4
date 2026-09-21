import { storedInt64Text } from "./storedInt64Text";

export function storedNullableInt64Text(value: unknown): string | null {
  if (value === null) return null;
  return storedInt64Text(value);
}
