import type { KnowledgeAccess } from "../knowledge/transport";

/**
 * #31: where the connected `KnowledgeAccess` (opened by `composition.ts`)
 * lives for MCP dispatch. Set once at startup; unset means every `kb_*` tool
 * fails closed with a tool error rather than silently pretending to work.
 *
 * ONE identity, shared by index.configureKnowledgeAccess.ts (the only writer)
 * and index.dispatchTool.ts / index.createMcpAdapter.ts (readers) -- splitting
 * this module state out is what keeps that identity single.
 */
export const knowledgeAccessState: { current: KnowledgeAccess | null } = { current: null };
