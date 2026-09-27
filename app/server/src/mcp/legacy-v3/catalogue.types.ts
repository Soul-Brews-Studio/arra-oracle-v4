/**
 * The v3-compatible catalogue entry shape, shared by `catalogue.ts` and its
 * builders (`catalogue.spec.ts`, `catalogue.str.ts`, etc). No behaviour here.
 */

import type { WorkspaceAction } from "../../auth/policy";

export type V3ToolSpec = {
  readonly name: string;
  readonly action: Extract<WorkspaceAction, "content:read" | "content:write">;
  readonly alsoNeeds?: readonly Extract<WorkspaceAction, "content:read">[];
  readonly uses: readonly string[];
  readonly requires: readonly string[];
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};
