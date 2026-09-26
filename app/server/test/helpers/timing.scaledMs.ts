/**
 * R13 (docs/overnight/DECISIONS.md): the one knob every wall-clock window in
 * the suite is multiplied by. `TEST_TIME_SCALE` defaults to 1, so the dev box
 * runs every window exactly as written; CI raises it because the GitHub runner
 * was measured about 4.6x slower per file than `test.census.tsv` (runs
 * 36260049043, 36265042727, 36265462602: 4902 s of test time against 1069 s).
 *
 * Use it for a window the code under test waits out (an injected timeout, a
 * parent deadline, a "never a hang" upper bound), never to make an ordering
 * claim: order is proven with a handshake, not with a faster clock.
 *
 * Read on every call, not at import, so a test can drive it through a child's
 * environment. A value below 1, or not a number, is refused: silently
 * shrinking windows would turn a typo into flakes.
 */
export function scaledMs(ms: number): number {
  const raw = process.env.TEST_TIME_SCALE;
  if (raw === undefined || raw === "") return ms;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale < 1) {
    throw new Error(`TEST_TIME_SCALE must be a finite number >= 1, got ${JSON.stringify(raw)}`);
  }
  return Math.ceil(ms * scale);
}
