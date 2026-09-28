import { wireInteger } from "./db.wireInteger";

// Normalizes a stored timestamp column to a wire-safe value: a `Date` ->
// ISO string, a raw bigint/number timestamp -> wireInteger, anything else ->
// String(value). `null`/`undefined` pass through as `null`.
export const wireTime = (value: unknown) => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint" || typeof value === "number") return wireInteger(value);
  return String(value);
};
