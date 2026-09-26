import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { termsOf } from "../termsOf";
import { SERVER_NAME, SERVER_VERSION } from "../../protocol";

/** v3's own default (`DEFAULT_TOP_N`, arra-oracle-v3@61e5f8b6
 *  src/tools/recap.ts). v3 capped at 20; accepting up to 100 is a superset a
 *  v3 client never reaches. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 100;
/** A character-count proxy for a token budget: no tokenizer runs here, and
 *  roughly 4 characters per token is the usual English/markdown estimate.
 *  ~2000 tokens' worth, generous for a recap meant to be skimmed. */
const MAX_BODY_CHARS = 8000;

type Entry = { id: string; title: string; project: string; longTerm: boolean; body: string };
type Warning = { code: string; field: string; detail: string };

const TRUNCATED: Warning = { code: "truncated", field: "recap", detail: "the token budget was reached; later entries were dropped" };

/** The plain-text compat footer (see the doc comment below). Also the shape
 *  `dispatchLegacyV3.ts` extends, rather than opening a second footer. */
const footerOf = (warnings: Warning[]) => `\n---\n${warnings.map((w) => `_compat(${w.code}): ${w.field} — ${w.detail}_`).join("\n")}\n`;

/**
 * `oracle_recap` (0 real calls; content:read; V3-PARITY.md §2.5/§5/§7 K3+K4,
 * V6). A markdown recap: an identity line, then the newest recall-eligible
 * entries (K4's `order: "updated_desc"` over `listNodes`'s `eligible_only`
 * view -- R18 D3 fix round: the default view dropped only retired/superseded
 * nodes, so forgotten (`is_active: false`) and out-of-window entries leaked
 * into this recall tool), grouped by `project`, with `memory_horizon:
 * long_term` entries listed before short-term/unset ones within the overall
 * newest-first order. Heat ranking is not carried (no popularity/decay
 * columns exist, AGENTS.md rule). The token budget is fitted HERE, in the
 * adapter: v4's kernels take no token count, only byte/row bounds.
 *
 * Fix round (Opus verifier): §2.5 says "oracle_recap returns a markdown
 * string, as v3 did; text() passes strings through", and v3's own
 * `recap.ts:52` returns raw markdown text -- so the WHOLE tool result IS the
 * markdown string, never a JSON object wrapping one. That leaves no `{...,
 * compat_warnings}` field to carry this tool's own warnings (heat,
 * truncated, and now v3's `maxTokens`, accepted but ignored -- v4 has no
 * token count, only the fixed character budget above): they are appended as
 * a plain-text footer to the SAME string instead, the only channel a
 * string-shaped v3 response has.
 */
export async function oracle_recap(args: Record<string, unknown>, context: V3ToolContext): Promise<string> {
  const { bank, kb, tool } = context;
  const rawLimit = args.limit === undefined || args.limit === null ? DEFAULT_LIMIT : args.limit;
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /limit", `limit must be an integer between 1 and ${MAX_LIMIT}`, { path: "/limit" });
  }
  const warnings: Warning[] = [
    { code: "field_unavailable", field: "heat", detail: "heat ranking is not carried; v4 has no popularity/decay columns" },
  ];
  if (args.maxTokens !== undefined && args.maxTokens !== null) {
    warnings.push({ code: "argument_ignored", field: "maxTokens", detail: "the adapter fits a fixed character budget instead; v3's token count has no v4 equivalent" });
  }

  const page = (await kb("listNodes", {
    workspace_name: bank, after_id: null, limit: rawLimit, include_total: false, type_term: null, order: "updated_desc", eligible_only: true,
  })) as { rows: Record<string, unknown>[] };

  const entries: Entry[] = [];
  for (const row of page.rows) {
    const head = (await kb("getAcceptedHead", { node_id: row.id })) as { revision: Record<string, unknown> } | null;
    if (head === null) continue;
    const parsed = termsOf(head.revision.term_snapshot_json as string);
    entries.push({
      id: row.id as string,
      // Whitespace collapses to single spaces, as v3's own `compact()` did:
      // a title is one bullet's text, never a place a newline can open a
      // heading or a fake list item (verifier finding).
      title: (head.revision.title as string).replace(/\s+/g, " ").trim(),
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
  // The footer is part of the same string, so it is paid for up front, at
  // its largest (every warning known so far plus `truncated`) -- the whole
  // result then stays within `MAX_BODY_CHARS` (verifier finding: the budget
  // used to cover only the entries). Dispatch-level warnings (e.g. `cwd`)
  // are appended later by `dispatchLegacyV3.ts` and are not in this budget.
  const limitChars = MAX_BODY_CHARS - footerOf([...warnings, TRUNCATED]).length;
  let budget = identity.length;
  let truncated = false;

  groups: for (const [project, list] of byProject) {
    const heading = `\n## ${project}\n`;
    if (budget + heading.length > limitChars) {
      truncated = true;
      break;
    }
    lines.push(heading);
    budget += heading.length;
    for (const entry of list) {
      const bullet = `- **${entry.title}**${entry.longTerm ? " (long_term)" : ""} [${entry.id}]\n`;
      if (budget + bullet.length > limitChars) {
        truncated = true;
        break groups;
      }
      lines.push(bullet);
      budget += bullet.length;
    }
  }

  if (truncated) warnings.push(TRUNCATED);

  // Footer, not a JSON field: this tool's whole result IS the markdown
  // string (see the doc comment above), so a warning has nowhere else to
  // travel. `dispatchLegacyV3.ts` appends its OWN generic warnings (e.g.
  // `cwd`) as extra lines of this SAME footer, never a second one.
  return lines.join("") + footerOf(warnings);
}
