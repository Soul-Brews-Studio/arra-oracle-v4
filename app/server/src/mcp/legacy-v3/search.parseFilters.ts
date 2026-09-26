import { CompatError } from "./compat-error";
import { normalizeProject } from "./normalizeProject";

export type CompatWarning = { code: string; field: string; detail: string };

/**
 * The v3 recall arguments `oracle_search` and `oracle_ask` share
 * (V3-PARITY.md §4.4, A5):
 *  - `type`: absent or `all` is no filter; any other string is v3's type
 *    string, matched against each result's own `type` (A5: `learning`, or the
 *    `legacy_type` a v3 principle/pattern/retro was kept as).
 *  - `project`: absent or blank is no filter; otherwise normalized exactly as
 *    `oracle_learn` stores it (`normalizeProject`).
 *  - `model`: ignored and named -- the embedding model is the server's, and the
 *    column is frozen at 384 dimensions, which no v3 model fits.
 *  - `asOf`: refused. v4 recall is as of now; valid-time search is not carried.
 */
export function parseFilters(tool: string, args: Record<string, unknown>): { type: string | null; project: string | null; warnings: CompatWarning[] } {
  const warnings: CompatWarning[] = [];
  if (Object.hasOwn(args, "asOf") && args.asOf !== undefined && args.asOf !== null) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /asOf: valid-time search is not carried",
      "v4 recall answers current entries only; read history by id with oracle_read", { path: "/asOf" });
  }
  let type: string | null = null;
  if (args.type !== undefined && args.type !== null) {
    if (typeof args.type !== "string") {
      throw new CompatError(tool, "unsupported_argument", "Invalid input at /type: expected a string", "type is a v3 type name or all", { path: "/type" });
    }
    type = args.type.trim() === "" || args.type === "all" ? null : args.type;
  }
  let project: string | null = null;
  if (args.project !== undefined && args.project !== null) {
    if (typeof args.project !== "string") {
      throw new CompatError(tool, "unsupported_argument", "Invalid input at /project: expected a string", "project is owner/repo", { path: "/project" });
    }
    project = args.project.trim() === "" ? null : normalizeProject(args.project);
  }
  if (args.model !== undefined && args.model !== null) {
    warnings.push({ code: "argument_ignored", field: "model", detail: "the embedding model is the server's; v3's nomic/qwen3/bge-m3 do not fit the 384-dimension column" });
  }
  return { type, project, warnings };
}
