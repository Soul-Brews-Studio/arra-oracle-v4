import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { termsOf } from "../termsOf";
import { SERVER_NAME, SERVER_VERSION } from "../../protocol";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** A character-count proxy for a token budget: no tokenizer runs here, and
 *  roughly 4 characters per token is the usual English/markdown estimate.
 *  ~2000 tokens' worth, generous for a recap meant to be skimmed. */
const MAX_BODY_CHARS = 8000;

type Entry = { id: string; title: string; project: string; longTerm: boolean; body: string };

/**
 * `oracle_recap` (0 real calls; content:read; V3-PARITY.md §5/§7 K3+K4, V6).
 * A markdown recap: an identity line, then the newest eligible entries (K4's
 * `order: "updated_desc"`; `listNodes`'s default view already excludes
 * retired/superseded, D3), grouped by `project`, with `memory_horizon:
 * long_term` entries listed before short-term/unset ones within the overall
 * newest-first order. Heat ranking is not carried (no popularity/decay
 * columns exist, AGENTS.md rule). The token budget is fitted HERE, in the
 * adapter: v4's kernels take no token count, only byte/row bounds.
 */
export async function oracle_recap(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { bank, kb, tool } = context;
  const rawLimit = args.limit === undefined || args.limit === null ? DEFAULT_LIMIT : args.limit;
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /limit", `limit must be an integer between 1 and ${MAX_LIMIT}`, { path: "/limit" });
  }

  const page = (await kb("listNodes", {
    workspace_name: bank, after_id: null, limit: rawLimit, include_total: false, type_term: null, order: "updated_desc",
  })) as { rows: Record<string, unknown>[] };

  const entries: Entry[] = [];
  for (const row of page.rows) {
    const head = (await kb("getAcceptedHead", { node_id: row.id })) as { revision: Record<string, unknown> } | null;
    if (head === null) continue;
    const parsed = termsOf(head.revision.term_snapshot_json as string);
    entries.push({
      id: row.id as string,
      title: head.revision.title as string,
      project: parsed.project ?? "_universal",
      longTerm: parsed.horizon === "long_term",
      body: head.revision.body as string,
    });
  }

  // Stable sort: `memory_horizon: long_term` entries first, the newest-first
  // order `listNodes` already gave preserved WITHIN each of the two groups.
  const ordered = entries
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => {
      if (a.entry.longTerm !== b.entry.longTerm) return a.entry.longTerm ? -1 : 1;
      return a.position - b.position;
    })
    .map(({ entry }) => entry);

  const byProject = new Map<string, Entry[]>();
  for (const entry of ordered) {
    const list = byProject.get(entry.project);
    if (list === undefined) byProject.set(entry.project, [entry]);
    else list.push(entry);
  }

  const identity = `# Recap: ${bank}\n\n_${SERVER_NAME} ${SERVER_VERSION}_\n`;
  const lines: string[] = [identity];
  let budget = identity.length;
  let truncated = false;

  groups: for (const [project, list] of byProject) {
    const heading = `\n## ${project}\n`;
    if (budget + heading.length > MAX_BODY_CHARS) {
      truncated = true;
      break;
    }
    lines.push(heading);
    budget += heading.length;
    for (const entry of list) {
      const bullet = `- **${entry.title}**${entry.longTerm ? " (long_term)" : ""} [${entry.id}]\n`;
      if (budget + bullet.length > MAX_BODY_CHARS) {
        truncated = true;
        break groups;
      }
      lines.push(bullet);
      budget += bullet.length;
    }
  }

  return {
    recap: lines.join(""),
    entries: entries.length,
    compat_warnings: [
      { code: "field_unavailable", field: "heat", detail: "heat ranking is not carried; v4 has no popularity/decay columns" },
      ...(truncated ? [{ code: "truncated", field: "recap", detail: "the token budget was reached; later entries were dropped" }] : []),
    ],
  };
}
