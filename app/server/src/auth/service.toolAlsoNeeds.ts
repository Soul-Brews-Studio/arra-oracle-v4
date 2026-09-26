import type { WorkspaceAction } from "./policy";
import { V3_CATALOGUE } from "../mcp/legacy-v3/catalogue";

const NONE: readonly WorkspaceAction[] = Object.freeze([]);

/** R18: derived from `mcp/legacy-v3/catalogue.ts` `alsoNeeds`, like the action map. */
const V3_ALSO_NEEDS: Readonly<Record<string, readonly WorkspaceAction[]>> = Object.freeze(
  Object.fromEntries(V3_CATALOGUE.flatMap((tool) => (tool.alsoNeeds === undefined ? [] : [[tool.name, tool.alsoNeeds]]))),
);

/**
 * The actions `tool` needs ON TOP of `toolAction(tool)`, all of which the
 * principal must hold on the same workspace, from the same snapshot.
 *
 * Grants are exact (`policy.admit.ts`: no action implies another), so a tool
 * that both writes and answers with bank content -- `oracle_search_chain`
 * writes traces and returns the entries it found -- is listed and admitted
 * only to a principal holding content:read as well as content:write. Before
 * this, content:write alone ran it and read content HTTP and `kb_*` refuse
 * that principal. Owned by the service and derived from the catalogue, like
 * the action map, so an adapter can never waive it. Every other tool: none.
 */
export function toolAlsoNeeds(tool: string, v3Compat: boolean): readonly WorkspaceAction[] {
  if (v3Compat && Object.hasOwn(V3_ALSO_NEEDS, tool)) return V3_ALSO_NEEDS[tool]!;
  return NONE;
}
