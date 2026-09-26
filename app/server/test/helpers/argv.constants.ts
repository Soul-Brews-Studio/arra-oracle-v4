/**
 * Kernel limits on what a spawned child can be handed, and the harness's own
 * spill convention for anything larger (R13, docs/overnight/DECISIONS.md).
 *
 * Linux refuses any SINGLE argv or envp string longer than MAX_ARG_STRLEN
 * (32 pages = 131072 bytes, the terminating NUL included) with E2BIG at
 * exec. macOS has no per-string limit, only ARG_MAX (1 MiB for the whole
 * argv plus envp), so a 300 KiB argument passes on the dev box and kills the
 * spawn on the GitHub runner. Measured on runs 36260049043, 36265042727 and
 * 36265462602: `E2BIG: argument list too long, posix_spawn .../python` in
 * mcp-v3-writes, session-link-service and list-pagination-isolation.
 */

/** Longest single argv/envp string Linux will exec, in UTF-8 bytes (131072 minus the NUL). */
export const LINUX_MAX_ARG_STRING_BYTES = 32 * 4096 - 1;

/**
 * Arguments above this many UTF-8 bytes are written to a file and replaced by
 * `ARGFILE_PREFIX + path`. Half the Linux limit, so the whole argv plus the
 * inherited environment also stays far inside ARG_MAX on both platforms.
 */
export const ARGV_INLINE_MAX_BYTES = 64 * 1024;

/**
 * Marks a spilled argument. No payload a child parses starts with it (every
 * JSON payload starts with `{` or `[`), so the decoder can never mistake a
 * real value for a reference.
 */
export const ARGFILE_PREFIX = "@arra-argfile:";
