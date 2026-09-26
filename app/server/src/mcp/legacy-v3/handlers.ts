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
import { oracle_learn } from "./tools/oracle_learn";
import { oracle_research_note } from "./tools/oracle_research_note";
import { oracle_trace } from "./tools/oracle_trace";
import { oracle_trace_chain } from "./tools/oracle_trace_chain";
import { oracle_trace_distill } from "./tools/oracle_trace_distill";
import { oracle_trace_get } from "./tools/oracle_trace_get";
import { oracle_trace_list } from "./tools/oracle_trace_list";

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
  // V3 trace + V7 upgrades (V3-PARITY.md §4.2-4.3, K5).
  oracle_trace,
  oracle_trace_get,
  oracle_trace_chain,
  oracle_trace_distill,
  oracle_trace_list,
});
