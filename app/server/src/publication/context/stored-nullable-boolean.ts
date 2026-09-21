import { storedBoolean } from "./stored-boolean";

export function storedNullableBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : storedBoolean(value);
}
