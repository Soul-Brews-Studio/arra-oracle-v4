/**
 * #31 maint-audit (Nat 2026-09-28 D4b): the instance-level audit wrapper for
 * the two GLOBAL maintenance routes (`service.ts backfill`/`reindex`). Split
 * out so `service.ts` stays under the line cap.
 *
 * `write` is INJECTED (`StoreDependencies.logInstanceAudit`), never imported
 * directly, so a test that supplies no store dependency for it (nearly every
 * existing fixture) gets a no-op rather than a real filesystem write to
 * whatever `ARRA_DATA_DIR` defaults to -- see `service.types.ts`'s field doc
 * for the concrete regression that shipped without this.
 *
 * `admit` runs FIRST and either returns the admitted principal or throws
 * `AuthDenied` -- exactly like every other admission in that module -- so a
 * refused call writes an `outcome: "refused"` row with no principal, and an
 * admitted call writes `outcome: "admitted"` whether `run` then succeeds or
 * throws. One row either way; never zero, never two.
 *
 * #31 R25 (Nat D4b): `route`/`action` widened from the two maintenance
 * literals to `string` so `/api/instance-audit`'s own reader (an
 * `instance-audit:read` action, not a `GlobalAction`) can reuse this same
 * one-row-either-way wrapper instead of a second copy of the try/catch shape.
 */

export async function withInstanceAudit<T>(
  write: (record: Record<string, unknown>) => Promise<void>,
  route: string,
  action: string,
  input: unknown,
  admit: () => { principalId: string | null },
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const requestId = `req_${started.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const row = (outcome: "admitted" | "refused", status: "ok" | "error", principalId: string | null) => ({
    principal_id: principalId,
    route,
    action,
    outcome,
    status,
    input,
    started_at: started,
    finished_at: Date.now(),
    request_id: requestId,
  });
  let principalId: string | null;
  try {
    ({ principalId } = admit());
  } catch (error) {
    await write(row("refused", "error", null));
    throw error;
  }
  try {
    const value = await run();
    await write(row("admitted", "ok", principalId));
    return value;
  } catch (error) {
    await write(row("admitted", "error", principalId));
    throw error;
  }
}
