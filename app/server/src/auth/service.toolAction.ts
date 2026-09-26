import type { WorkspaceAction } from "./policy";
import { KNOWLEDGE_METHODS } from "../knowledge/registry";
import { V3_CATALOGUE } from "../mcp/legacy-v3/catalogue";

/**
 * The authoritative tool -> action map.
 *
 * Owned by the service, not supplied by a caller: letting an adapter choose
 * which action a tool required would let it pick the cheapest grant it
 * happened to hold. Each family is DERIVED from its own data table, so adding
 * an entry there admits and lists it with no edit here.
 */
const MEMORY_TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = {
  remember: "content:write",
  recall: "content:read",
  get_memory: "content:read",
  list_memories: "content:read",
  bank_info: "diagnostics:read",
  status: "diagnostics:read",
  call_log: "audit:read",
  call_stats: "audit:read",
};

/** #31: `kb_<method>` -> the same action `knowledge/registry.ts` declares. */
const KNOWLEDGE_TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = Object.fromEntries(
  Object.entries(KNOWLEDGE_METHODS).map(([method, entry]) => [`kb_${method}`, entry.action]),
);

const BASE_TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = Object.freeze({
  ...MEMORY_TOOL_ACTION,
  ...KNOWLEDGE_TOOL_ACTION,
});

/** R18: the v3 family, derived from `mcp/legacy-v3/catalogue.ts`. */
const V3_TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = Object.freeze(
  Object.fromEntries(V3_CATALOGUE.map((tool) => [tool.name, tool.action])),
);

/**
 * The action `tool` needs, or undefined for a tool that does not exist. With
 * the family flag off (`ARRA_MCP_V3_COMPAT`, R18 D10) a v3 name does not
 * exist, so it is refused exactly like an unknown tool.
 */
export function toolAction(tool: string, v3Compat: boolean): WorkspaceAction | undefined {
  if (Object.hasOwn(BASE_TOOL_ACTION, tool)) return BASE_TOOL_ACTION[tool];
  if (v3Compat && Object.hasOwn(V3_TOOL_ACTION, tool)) return V3_TOOL_ACTION[tool];
  return undefined;
}
