/**
 * Data-only constants and types shared by the composition root's split
 * files (`composition.ts` §header). No functions here: a previous slice was
 * refuted for an object whose properties were functions, so this file stays
 * plain values/types only, split out of `composition.ts` verbatim.
 */

export type RuntimeConfig = {
  readonly policyPath: string;
  readonly origin: string;
  readonly port: number;
  /** R18 D10: the v3-compatible MCP family. Absent = off. */
  readonly v3Compat?: boolean;
};

/**
 * The transports this build has raw-wire evidence for.
 *
 * The header-flattening and body-bound behaviour was measured on exactly these
 * versions. An unsupported runtime must REFUSE to start rather than warn and
 * continue, because the grammar gate silently depends on that behaviour.
 */
export const SUPPORTED_BUN = "1.3.14";
export const SUPPORTED_ELYSIA = "1.4.30";

/** The explicit global body backstop, deliberately ABOVE the 256 KiB route cap. */
export const GLOBAL_BODY_BACKSTOP = 1024 * 1024;

export type VersionCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };
