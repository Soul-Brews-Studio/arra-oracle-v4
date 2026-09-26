/**
 * `oracle_trace`'s dig points (V3-PARITY.md §4.2, slice V3): translate v3's
 * `foundFiles`/`foundCommits`/`foundIssues`/`foundRetrospectives`/
 * `foundLearnings`/`foundResonance` into `createTrace` hits plus the
 * `h_metadata.legacy` block, and read them back for `oracle_trace_get`.
 *
 * Only a full-length commit hash (40-hex sha1 or 64-hex sha256) under a
 * `project` that parses to `owner/repo` becomes an indexed `commit` hit (the
 * evidence contract's target validation requires exactly that shape); the
 * same `repo` gates every issue hit too, since neither commits nor issues
 * carry their own `repo` field in v3's real call shape (only the
 * trace-level `project` does). Anything that does not qualify is
 * `unrepresentable_*`, kept
 * verbatim in `h_metadata.legacy` so the count is not lost -- v3 counted
 * every input item regardless (`store.ts`'s `arrayCount`), so `summary`
 * counts the RAW input arrays, never the representable subset.
 */

const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function parseProjectRepo(project: unknown): string | null {
  if (typeof project !== "string") return null;
  const stripped = project.replace(/^github\.com\//i, "");
  const parts = stripped.split("/");
  if (parts.length !== 2) return null;
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === ".." || !REPO_SEGMENT.test(part)) return null;
  }
  return stripped.toLowerCase();
}

function commitAlgorithm(hash: unknown): "sha1" | "sha256" | null {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]+$/.test(hash)) return null;
  if (hash.length === 40) return "sha1";
  if (hash.length === 64) return "sha256";
  return null;
}

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export type TraceHitsBuild = {
  hits: Record<string, unknown>[];
  legacy: Record<string, unknown>;
  summary: { file_count: number; commit_count: number; issue_count: number; total_dig_points: number };
};

/** Build `createTrace`'s `hits` array and `h_metadata.legacy` from v3's raw
 *  `foundFiles`/`foundCommits`/`foundIssues`/… arguments. */
export function buildTraceHits(args: Record<string, unknown>): TraceHitsBuild {
  const foundFiles = arrayOf(args.foundFiles);
  const foundCommits = arrayOf(args.foundCommits);
  const foundIssues = arrayOf(args.foundIssues);
  const foundRetrospectives = arrayOf(args.foundRetrospectives);
  const foundLearnings = arrayOf(args.foundLearnings);
  const foundResonance = arrayOf(args.foundResonance);

  const repo = parseProjectRepo(args.project);
  const hits: Record<string, unknown>[] = [];
  const unrepresentableCommits: unknown[] = [];
  for (const raw of foundCommits) {
    const commit = raw as Record<string, unknown>;
    const algorithm = repo === null ? null : commitAlgorithm(commit?.hash);
    if (repo === null || algorithm === null) {
      unrepresentableCommits.push(raw);
      continue;
    }
    const hash = String(commit.hash).toLowerCase();
    hits.push({
      kind: "commit",
      target: { repo, commit: { algorithm, oid: hash } },
      ref: typeof commit.shortHash === "string" && commit.shortHash !== "" ? commit.shortHash : hash,
      line_start: null,
      line_end: null,
      excerpt: typeof commit.message === "string" ? commit.message : null,
      content_hash: null,
      captured_at: null,
      note: typeof commit.date === "string" ? `date=${commit.date}` : null,
    });
  }

  const unrepresentableIssues: unknown[] = [];
  for (const raw of foundIssues) {
    const issue = raw as Record<string, unknown>;
    const number = typeof issue?.number === "number" && Number.isInteger(issue.number) && issue.number > 0 ? issue.number : null;
    if (repo === null || number === null) {
      unrepresentableIssues.push(raw);
      continue;
    }
    const url = typeof issue.url === "string" && issue.url !== "" ? issue.url : `https://github.com/${repo}/issues/${number}`;
    hits.push({
      kind: "issue",
      target: { repo, number: String(number), url },
      ref: `#${number}`,
      line_start: null,
      line_end: null,
      excerpt: typeof issue.title === "string" ? issue.title : null,
      content_hash: null,
      captured_at: null,
      note: typeof issue.state === "string" ? `state=${issue.state}` : null,
    });
  }

  // v3's own count (`trace/store.ts`): file_count folds in retrospectives,
  // learnings and resonance -- none of the four get their own indexed hit
  // kind (no local-path target exists, V3-PARITY.md §4.2), so all four are
  // kept verbatim in `legacy` and counted together, exactly as v3 counted them.
  const file_count = foundFiles.length + foundRetrospectives.length + foundLearnings.length + foundResonance.length;
  const commit_count = foundCommits.length;
  const issue_count = foundIssues.length;

  return {
    hits,
    legacy: {
      found_files: foundFiles,
      found_retrospectives: foundRetrospectives,
      found_learnings: foundLearnings,
      found_resonance: foundResonance,
      unrepresentable_commits: unrepresentableCommits,
      unrepresentable_issues: unrepresentableIssues,
    },
    summary: { file_count, commit_count, issue_count, total_dig_points: file_count + commit_count + issue_count },
  };
}

export type TraceFoundArrays = {
  found_files: unknown[];
  found_commits: unknown[];
  found_issues: unknown[];
  found_retrospectives: unknown[];
  found_learnings: unknown[];
  found_resonance: unknown[];
};

/** Read `found_*` back for `oracle_trace_get`: files/retrospectives/
 *  learnings/resonance verbatim from `legacy`; commits/issues rebuilt from
 *  the indexed hits (representable) followed by `legacy`'s unrepresentable
 *  ones (a v3 change: v3 kept one array in insertion order; the adapter's
 *  split store cannot reproduce that interleaving, so hit position order
 *  wins for the representable prefix). */
export function readTraceHits(legacy: Record<string, unknown> | null, hits: readonly Record<string, unknown>[]): TraceFoundArrays {
  const l = legacy ?? {};
  const commits: unknown[] = [];
  const issues: unknown[] = [];
  for (const hit of hits) {
    // `target` is the stored CANONICAL JSON TEXT (`trace.encodeTraceHitRow.ts`
    // keeps it a string on purpose: "re-parsing it here would invent a shape
    // the wire contract does not define for a read path"). THIS reader is
    // exactly that shape, so it parses -- once, here, never further upstream.
    let target: Record<string, unknown> | undefined;
    try {
      target = typeof hit.target === "string" ? (JSON.parse(hit.target) as Record<string, unknown>) : undefined;
    } catch {
      target = undefined;
    }
    if (hit.kind === "commit" && target !== undefined) {
      const commit = target.commit as Record<string, unknown> | undefined;
      const oid = typeof commit?.oid === "string" ? commit.oid : "";
      const ref = typeof hit.ref === "string" ? hit.ref : oid;
      commits.push({
        hash: oid,
        shortHash: ref !== oid ? ref : oid.slice(0, 7),
        message: hit.excerpt ?? null,
        date: typeof hit.note === "string" ? hit.note.replace(/^date=/, "") : null,
      });
    } else if (hit.kind === "issue" && target !== undefined) {
      const number = Number(target.number);
      issues.push({
        number: Number.isFinite(number) ? number : target.number,
        title: hit.excerpt ?? null,
        state: typeof hit.note === "string" ? hit.note.replace(/^state=/, "") : null,
        url: target.url ?? null,
      });
    }
  }
  return {
    found_files: arrayOf(l.found_files),
    found_commits: [...commits, ...arrayOf(l.unrepresentable_commits)],
    found_issues: [...issues, ...arrayOf(l.unrepresentable_issues)],
    found_retrospectives: arrayOf(l.found_retrospectives),
    found_learnings: arrayOf(l.found_learnings),
    found_resonance: arrayOf(l.found_resonance),
  };
}
