/**
 * R20: the digest the most recent `embedPendingChunks` probe in THIS
 * process measured, per canonical dataset root -- `null` when that probe
 * could not measure. Absent when no run has probed yet in this process.
 * `getSearchFreshness` reports it as `last_measured`; nothing else reads it,
 * and it never decides anything (the pin file does). In memory on purpose:
 * it is an observation of the serving model, not dataset state, so a
 * restarted server honestly reports it as unknown until its first run.
 *
 * Same shape and keying as `service.owners.ts`'s `OWNERS`.
 */
export const LAST_MEASURED_MODEL_DIGESTS = new Map<string, string | null>();
