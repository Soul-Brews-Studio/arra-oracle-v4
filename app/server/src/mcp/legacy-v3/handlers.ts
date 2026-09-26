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
import { oracle_concepts } from "./tools/oracle_concepts";
import { oracle_handoff } from "./tools/oracle_handoff";
import { oracle_ask } from "./tools/oracle_ask";
import { oracle_learn } from "./tools/oracle_learn";
import { oracle_read } from "./tools/oracle_read";
import { oracle_inbox } from "./tools/oracle_inbox";
import { oracle_list } from "./tools/oracle_list";
import { oracle_reflect } from "./tools/oracle_reflect";
import { oracle_recap } from "./tools/oracle_recap";
import { oracle_research_note } from "./tools/oracle_research_note";
import { oracle_search } from "./tools/oracle_search";
import { oracle_search_chain } from "./tools/oracle_search_chain";
import { oracle_supersede } from "./tools/oracle_supersede";
import { oracle_verify } from "./tools/oracle_verify";
import { oracle_thread } from "./tools/oracle_thread";
import { oracle_thread_read } from "./tools/oracle_thread_read";
import { oracle_thread_update } from "./tools/oracle_thread_update";
import { oracle_threads } from "./tools/oracle_threads";
import { oracle_stats } from "./tools/oracle_stats";
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
  // V5 recall over the #30 knowledge searches (V3-PARITY.md §4.4).
  oracle_search,
  oracle_ask,
  oracle_search_chain,
  // V2 knowledge reads (V3-PARITY.md §4.2/§4.3, §7 "V2"; DECISIONS.md R18 D3).
  oracle_read,
  oracle_supersede,
  oracle_verify,
  // V4 + V10 forum over sessions and messages (V3-PARITY.md §4.2-§4.4).
  oracle_thread,
  oracle_threads,
  oracle_thread_read,
  oracle_thread_update,
  // V8 (docs/overnight/V3-PARITY.md §4.3/§4.4, §7 "V8"; DECISIONS.md R18
  // (K6+K7+V8)): concept usage counts and full workspace stats.
  oracle_concepts,
  oracle_stats,
  // V3 trace + V7 upgrades (V3-PARITY.md §4.2-4.3, K5).
  oracle_trace,
  oracle_trace_get,
  oracle_trace_chain,
  oracle_trace_distill,
  oracle_trace_list,
  // V6 knowledge reads (V3-PARITY.md §5/§7 K3+K4; overnight R18).
  oracle_list,
  oracle_reflect,
  oracle_inbox,
  oracle_recap,
});
