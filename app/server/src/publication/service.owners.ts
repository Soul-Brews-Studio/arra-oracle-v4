/**
 * One owner per canonical dataset root, per process.
 *
 * The external gate excludes other PROCESSES; this excludes a second owner
 * inside this one. Keyed by canonical root so two spellings cannot both win.
 */
export const OWNERS = new Map<string, symbol>();
