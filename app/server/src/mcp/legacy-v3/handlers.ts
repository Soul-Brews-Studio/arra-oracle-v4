/**
 * The v3 tools this build actually implements, by name. DATA ONLY.
 *
 * A carried tool with no entry here is not advertised, and calling it with
 * the action held answers `not_yet_available` (`availability.ts`). Each
 * tool's own file lives under `tools/` (V3-PARITY.md §7 ownership).
 */

import type { RequestAuthority } from "../../knowledge/registry";
import type { IndexProfile } from "../../knowledge/transport.indexProfile";
import type { Kb } from "./createKb";
import { guide } from "./guide";
import { oracle_handoff } from "./tools/oracle_handoff";
import { oracle_ask } from "./tools/oracle_ask";
import { oracle_learn } from "./tools/oracle_learn";
import { oracle_research_note } from "./tools/oracle_research_note";
import { oracle_search } from "./tools/oracle_search";
import { oracle_search_chain } from "./tools/oracle_search_chain";

export type V3ToolContext = {
  readonly tool: string;
  readonly bank: string;
  readonly kb: Kb;
  /** A7/D8: the connection-level speaker (X-Arra-Peer), already checked against the grant. */
  readonly assertedPeer: string | null;
  readonly authority: RequestAuthority;
  /** Server configuration for index requests; the caller never chooses it. */
  readonly indexProfile: IndexProfile;
};

export type V3Handler = (args: Record<string, unknown>, context: V3ToolContext) => Promise<unknown>;

export const V3_HANDLERS: Readonly<Record<string, V3Handler>> = Object.freeze({
  ____IMPORTANT: async () => guide(),
  // V1 knowledge writes (V3-PARITY.md §4.3).
  oracle_learn,
  oracle_research_note,
  oracle_handoff,
  // V5 recall over the #30 knowledge searches (V3-PARITY.md §4.4).
  oracle_search,
  oracle_ask,
  oracle_search_chain,
});
