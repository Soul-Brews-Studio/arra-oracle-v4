import { scaledMs } from "./timing.scaledMs";

/**
 * The value to hand bun as an explicit per-test or hook timeout for a budget
 * of `ms`. bun's `--timeout` (fed by `TEST_TIMEOUT_MS` in `test.parallel.ts`)
 * only sets the default, and an explicit timeout overrides it, so without
 * this a slow runner could raise every budget except the ones written down.
 *
 * The budget scales with `TEST_TIME_SCALE` like every other window, and never
 * drops below `TEST_TIMEOUT_MS` when that is set: an explicit timeout may be
 * more generous than the runner's default, never stricter.
 */
export function testTimeout(ms: number): number {
  const scaled = scaledMs(ms);
  const raw = process.env.TEST_TIMEOUT_MS;
  if (raw === undefined || raw === "") return scaled;
  const floor = Number(raw);
  if (!Number.isFinite(floor) || floor <= 0) {
    throw new Error(`TEST_TIMEOUT_MS must be a finite number of milliseconds > 0, got ${JSON.stringify(raw)}`);
  }
  return Math.max(scaled, floor);
}
