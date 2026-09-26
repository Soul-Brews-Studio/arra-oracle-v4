/**
 * Shared bound for every small paging/limit-style CLI flag: a decimal
 * integer with no leading zero, from 1 up to `max`. Used by `app/cli.ts`'s
 * own `--limit`/`--batch` flags and by `kb.aliases.ts`'s paging flags, so the
 * two paths reject the same malformed input the same way instead of drifting.
 */
export function positiveInt(value: string | undefined, name: string, fallback: number, max = 1000): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new Error(`--${name} must be an integer from 1 to ${max}`);
  }
  return Number(value);
}
