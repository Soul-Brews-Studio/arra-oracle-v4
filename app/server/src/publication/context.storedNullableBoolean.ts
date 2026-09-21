import { storedBoolean } from "./context.storedBoolean";

export function storedNullableBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : storedBoolean(value);
}
