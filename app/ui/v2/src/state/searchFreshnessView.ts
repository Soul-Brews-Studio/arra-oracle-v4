import type { SearchFreshness } from "../api/getSearchFreshness";
import type { SearchChunkStatusRow } from "../api/listSearchChunks";

/** What `useSearchFreshness` read. `freshness`/`chunks` stay `unknown` here on
 *  purpose: the shape is checked below, and a shape this UI does not know is
 *  `unknown`, not a zero. */
export type FreshnessRead =
  | { phase: "loading" }
  | { phase: "error"; stage: "freshness" | "chunks"; message: string }
  | { phase: "ok"; freshness: unknown; chunks: unknown };

export type FreshnessState = "loading" | "unknown" | "unindexed" | "pending" | "failed" | "indexed";

export type FreshnessView = {
  state: FreshnessState;
  label: string;
  meaning: string;
  /** The active embedding profile the node was checked against. */
  profile: string | null;
  chunks: { total: number; pending: number; ready: number; failed: number } | null;
  errorCodes: string[];
  /** `getSearchFreshness`'s own figures -- the WORKSPACE's, never this node's. */
  workspace: { key: string; label: string; value: string }[] | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNullStr = (v: unknown): v is string | null => v === null || typeof v === "string";
const isNullNum = (v: unknown): v is number | null => v === null || isNum(v);

function asFreshness(v: unknown): SearchFreshness | null {
  if (!isObj(v) || !isObj(v.content) || !isObj(v.text_index) || !isObj(v.vectors)) return null;
  const { vectors: x, text_index: t } = v;
  if (typeof x.profile_id !== "string" || !isNum(x.pending) || !isNum(x.ready) || !isNum(x.failed)) return null;
  if (!isNullStr(x.last_attempt_at) || !isObj(x.model_digest)) return null;
  if (!isNullStr(x.model_digest.pinned) || !isNullStr(x.model_digest.last_measured)) return null;
  if (!isNullNum(t.indexed_rows) || !isNullNum(t.unindexed_rows)) return null;
  return v as SearchFreshness;
}

function asChunks(v: unknown): SearchChunkStatusRow[] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.every((c) => isObj(c) && (c.status === "pending" || c.status === "ready" || c.status === "failed"));
  return ok ? (v as SearchChunkStatusRow[]) : null;
}

const unknown = (why: string): FreshnessView => ({
  state: "unknown",
  label: "unknown",
  meaning: `Search freshness could not be read (${why}). This is not a claim that it is fresh.`,
  profile: null,
  chunks: null,
  errorCodes: [],
  workspace: null,
});

function workspaceRows(f: SearchFreshness): FreshnessView["workspace"] {
  const { text_index: t, vectors: v } = f;
  const digest =
    `${v.model_digest.pinned === null ? "not pinned yet" : `pinned ${v.model_digest.pinned}`} · ` +
    (v.model_digest.last_measured === null
      ? "not measured by this server process"
      : `last measured ${v.model_digest.last_measured}`);
  return [
    { key: "profile", label: "embedding profile", value: v.profile_id },
    { key: "vectors", label: "vectors (workspace)", value: `${v.ready} ready · ${v.pending} pending · ${v.failed} failed` },
    {
      key: "text_index",
      label: "text index (workspace)",
      value:
        t.indexed_rows === null || t.unindexed_rows === null
          ? "unknown — no index yet, or shared with another workspace"
          : `${t.indexed_rows} rows indexed · ${t.unindexed_rows} not yet`,
    },
    { key: "last_attempt", label: "last embed attempt", value: v.last_attempt_at ?? "never attempted" },
    { key: "model_digest", label: "model digest", value: digest },
    { key: "content", label: "content (workspace)", value: `${f.content.nodes} nodes · ${f.content.revisions} revisions` },
  ];
}

/** #33 design revision 2 "render freshness", fed by #30's `getSearchFreshness`.
 *
 * That method is workspace-wide (its request is `workspace_name` only), so the
 * NODE's state is read off its head revision's own chunks under the active
 * profile `getSearchFreshness` names; the workspace figures ride along,
 * labelled as the workspace's. The node states, in the server's own terms:
 *
 *   unindexed -- no chunk for this revision under the active profile yet, so
 *                neither search can see it (`indexRevisionChunks` not run)
 *   pending   -- chunked, some vectors not written yet: keyword search reads
 *                chunk text, semantic search reads only `ready` chunks. A
 *                queue state, not an error.
 *   failed    -- at least one chunk's embed attempt failed (closed error_code);
 *                `embedPendingChunks` retries it under its attempt cap. The
 *                content itself was saved -- embedding is off that path.
 *   indexed   -- every chunk `ready` under the active profile.
 *
 * Anything else -- a failed read of either method, or a shape this UI does
 * not know -- is `unknown`, which never renders as fresh. */
export function searchFreshnessView(read: FreshnessRead): FreshnessView {
  if (read.phase === "loading") {
    return { ...unknown("still loading"), state: "loading", label: "checking…", meaning: "Reading search freshness…" };
  }
  if (read.phase === "error") return unknown(`${read.stage}: ${read.message}`);
  const f = asFreshness(read.freshness);
  if (f === null) return unknown("getSearchFreshness answered in a shape this view does not know");
  const rows = asChunks(read.chunks);
  if (rows === null) return unknown("listSearchChunks answered in a shape this view does not know");

  const count = (s: SearchChunkStatusRow["status"]) => rows.filter((r) => r.status === s).length;
  const chunks = { total: rows.length, pending: count("pending"), ready: count("ready"), failed: count("failed") };
  const errorCodes = [...new Set(rows.flatMap((r) => (r.status === "failed" && r.error_code ? [r.error_code] : [])))];
  const base = { profile: f.vectors.profile_id, chunks, errorCodes, workspace: workspaceRows(f) };
  const of = `of ${chunks.total} chunks`;

  if (chunks.total === 0) {
    return {
      ...base,
      state: "unindexed",
      label: "unindexed",
      meaning: "This revision has no search chunks under the active profile yet, so neither keyword nor semantic search can find it.",
    };
  }
  if (chunks.failed > 0) {
    return {
      ...base,
      state: "failed",
      label: "failed — embedding failed",
      meaning: `${chunks.failed} ${of} failed to embed; semantic search cannot see them until a retry succeeds. The content itself is saved.`,
    };
  }
  if (chunks.pending > 0) {
    return {
      ...base,
      state: "pending",
      label: "pending — not embedded yet",
      meaning: `${chunks.pending} ${of} wait for the embed worker; semantic search skips them until then. Keyword search reads chunk text already.`,
    };
  }
  return {
    ...base,
    state: "indexed",
    label: "indexed",
    meaning: `All ${chunks.total} chunks have a vector under the active profile; keyword and semantic search can both find this revision.`,
  };
}
