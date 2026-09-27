import { type ConclusionItem } from "./chat";
import { failPublication } from "./errors";
import { encodeRevisionRow } from "./rows";
import { quote } from "./storage";
import { NODES, NODE_REVISIONS, SUPERSEDE_LOG } from "./service.constants";
import { conclusionSources } from "./service.conclusionSources";
import { contextScope } from "./service.contextScope";
import { deriveNodeType } from "./service.deriveNodeType";
import { eligibilityReasonsOf } from "./service.eligibilityReasonsOf";
import { terminalEventsFor } from "./service.terminalEventsFor";
import { type DatasetAdapter } from "./service.types";

/**
 * How many nodes, most recently updated first, one selection examines. The
 * same bound and reason as `listNodes`' `MAX_SCANNED_NODES`: a rare
 * perspective must never turn one read into an unbounded scan. Reaching it
 * is reported (coarse `incomplete`), never silent.
 */
export const MAX_SCANNED_CONCLUSION_NODES = 1000;
/** Head revisions fetched per `id IN (...)` query. */
const HEAD_BATCH = 200;

export type ConclusionSelection = {
  conclusions: ConclusionItem[];
  summary: ConclusionItem | null;
  /** Something eligible was withheld: protected, a protected source, or the scan bound. */
  incomplete: boolean;
  /** A count or byte bound stopped an eligible, visible conclusion. */
  truncated: boolean;
  usedBytes: number;
};

/**
 * D3b (DESIGN.md §12, R10): the eligible CURRENT `conclusion` revisions of
 * one workspace, optionally narrowed to one observer and/or one subject.
 * Shared by `getContext` and `getRepresentation`, so both apply ONE rule.
 *
 * Eligible = the node's accepted head (`nodes.current_revision_id`, never a
 * re-derived "latest"), no terminal `supersede_log` event (superseded or
 * retired), `is_active` and inside its validity window at `asOf` -- the
 * centralized #29 predicates via `eligibilityReasonsOf` -- and a `type` term
 * snapshot of `conclusion`. A `summary` head, when a workspace has such a
 * type term, is the stored summary; there is none otherwise (null).
 *
 * `inScope` is the caller's SCOPE and is asked first: a revision recorded in
 * a session outside it is simply not part of this read -- skipped, with no
 * flag, because flagging protected material the caller never asked for (and
 * narrowed by perspective) would be an existence oracle. A session-less
 * revision is workspace-level and always in scope.
 *
 * `canSeeSession` is the caller's read boundary INSIDE that scope: an in-scope
 * revision recorded in a session the caller may not read is withheld with
 * only the coarse `incomplete` flag. Observer/subject filter what is SELECTED
 * and are applied as SQL predicates on the head revisions; they never reach
 * either callback.
 *
 * The summary, when there is one, spends the same byte budget as the
 * conclusions (it is outside `maxItems` only, being at most one item).
 *
 * Read-only and model-free: `refresh`, `orderedProjection` and `query` only.
 */
export async function selectConclusions(
  reader: DatasetAdapter,
  options: {
    workspace: string;
    observer: string | null;
    subject: string | null;
    /** R24 (Nat D3b, #32): optional third narrowing key, SELECTION only --
     *  the same SQL-predicate shape as observer/subject, never a
     *  permissions check. Absent from `getRepresentation`'s call site. */
    author?: string | null;
    asOf: number;
    maxItems: number;
    byteBudget: number;
    inScope: (session: string) => Promise<boolean>;
    canSeeSession: (session: string) => Promise<boolean>;
  },
): Promise<ConclusionSelection> {
  const scope = contextScope(options.workspace);
  await reader.refresh(NODES);
  await reader.refresh(NODE_REVISIONS);
  await reader.refresh(SUPERSEDE_LOG);

  const nodeRows = await reader.orderedProjection(
    NODES,
    scope,
    ["id", "current_revision_id"],
    [
      { column: "updated_at", ascending: false },
      { column: "id", ascending: true },
    ],
    MAX_SCANNED_CONCLUSION_NODES + 1,
  );
  let incomplete = nodeRows.length > MAX_SCANNED_CONCLUSION_NODES;
  const heads: { nodeId: string; headId: string }[] = [];
  for (const row of nodeRows.slice(0, MAX_SCANNED_CONCLUSION_NODES)) {
    if (typeof row.id !== "string" || typeof row.current_revision_id !== "string") failPublication("integrity_failure", "");
    heads.push({ nodeId: row.id, headId: row.current_revision_id });
  }
  const terminal = await terminalEventsFor(reader, options.workspace, heads.map((h) => h.nodeId));
  const live = heads.filter((h) => !terminal.has(h.nodeId));

  let narrowing = " AND is_active = true";
  if (options.observer !== null) narrowing += ` AND observer_peer_name = ${quote(options.observer)}`;
  if (options.subject !== null) narrowing += ` AND subject_peer_name = ${quote(options.subject)}`;
  if (options.author !== undefined && options.author !== null) narrowing += ` AND author_peer_name = ${quote(options.author)}`;
  const byId = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < live.length; i += HEAD_BATCH) {
    const batch = live.slice(i, i + HEAD_BATCH);
    const list = batch.map((h) => quote(h.headId)).join(", ");
    const rows = await reader.query(NODE_REVISIONS, `${scope} AND id IN (${list})${narrowing}`, batch.length);
    for (const row of rows) byId.set(row.id as string, row);
  }

  const conclusions: ConclusionItem[] = [];
  let summary: ConclusionItem | null = null;
  let truncated = false;
  let usedBytes = 0;
  for (const head of live) {
    const row = byId.get(head.headId);
    if (row === undefined) continue; // filtered by perspective or inactive
    const revision = encodeRevisionRow(row);
    if (revision.node_id !== head.nodeId) failPublication("integrity_failure", "");
    if (eligibilityReasonsOf(null, revision, options.asOf).length > 0) continue;
    const kind = deriveNodeType(revision);
    if (kind !== "conclusion" && !(kind === "summary" && summary === null)) continue;
    const session = revision.session_name as string | null;
    if (session !== null && !(await options.inScope(session))) continue;
    if (session !== null && !(await options.canSeeSession(session))) {
      incomplete = true;
      continue;
    }
    const { sources, incomplete: hiddenSource } = await conclusionSources(revision, options.canSeeSession);
    if (hiddenSource) incomplete = true;
    const item: ConclusionItem = {
      node_id: head.nodeId,
      revision_id: revision.id as string,
      revision_no: revision.revision_no as string,
      title: revision.title as string,
      text: revision.body as string,
      author_peer_name: revision.author_peer_name as string | null,
      observer_peer_name: revision.observer_peer_name as string | null,
      subject_peer_name: revision.subject_peer_name as string | null,
      session_name: session,
      created_at: revision.created_at as string,
      sources,
      sources_incomplete: hiddenSource,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (kind === "summary") {
      if (usedBytes + bytes > options.byteBudget) {
        truncated = true;
        continue;
      }
      usedBytes += bytes;
      summary = item;
      continue;
    }
    if (conclusions.length >= options.maxItems || usedBytes + bytes > options.byteBudget) {
      truncated = true;
      continue;
    }
    usedBytes += bytes;
    conclusions.push(item);
  }
  return { conclusions, summary, incomplete, truncated, usedBytes };
}
