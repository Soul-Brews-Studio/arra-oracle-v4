import { CompatError } from "./compat-error";

/**
 * A v3 count argument (`limit`, `offset`, `maxHops`, `breadth`). v3 declared
 * them as JSON numbers and floored or clamped them rather than refusing, so
 * this does too: absent or null is `fallback`, a fraction is floored, above
 * `max` is clamped (`clamped: true`, for the caller to name). A value that is
 * not a finite number, or is below `min`, is refused at its own path.
 */
export function readCount(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  bounds: { fallback: number; min: number; max: number },
): { value: number; clamped: boolean } {
  const raw = args[key];
  if (raw === undefined || raw === null) return { value: bounds.fallback, clamped: false };
  if (typeof raw !== "number" || !Number.isFinite(raw) || Math.floor(raw) < bounds.min) {
    throw new CompatError(tool, "unsupported_argument", `Invalid input at /${key}: expected a number of at least ${bounds.min}`,
      `${key} must be a finite number >= ${bounds.min}`, { path: `/${key}` });
  }
  const value = Math.floor(raw);
  return value > bounds.max ? { value: bounds.max, clamped: true } : { value, clamped: false };
}
