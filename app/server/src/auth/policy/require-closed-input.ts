import { ownData } from "./own-data";
import { reject } from "./reject";

export function requireClosedInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("invalid_request");
  const o = value as Record<string, unknown>;
  for (const key of keys) {
    if (!ownData(o, key)) reject("invalid_request");
  }
  if (Reflect.ownKeys(o).length !== keys.length) reject("invalid_request");
  return o;
}
