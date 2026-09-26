/**
 * The v3 tools this build actually implements, by name. DATA ONLY.
 *
 * A carried tool with no entry here is not advertised, and calling it with
 * the action held answers `not_yet_available` (`availability.ts`). Each
 * tool's own file lives under `tools/` (V3-PARITY.md §7 ownership).
 */

import type { RequestAuthority } from "../../knowledge/registry";
import { guide } from "./guide";
import type { Kb } from "./kb";

export type V3ToolContext = {
  readonly tool: string;
  readonly bank: string;
  readonly kb: Kb;
  /** A7/D8: the connection-level speaker (X-Arra-Peer), already checked against the grant. */
  readonly assertedPeer: string | null;
  readonly authority: RequestAuthority;
};

export type V3Handler = (args: Record<string, unknown>, context: V3ToolContext) => Promise<unknown>;

export const V3_HANDLERS: Readonly<Record<string, V3Handler>> = Object.freeze({
  ____IMPORTANT: async () => guide(),
});
