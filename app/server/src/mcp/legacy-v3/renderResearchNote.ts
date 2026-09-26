import { normalizeRepo, requireUrl } from "../../contracts/evidence-v1";

/**
 * `oracle_research_note` body and links (V3-PARITY.md §4.3), a port of v3's
 * `buildResearchNoteLearning` / `findingSections` (arra-oracle-v3
 * src/research/note.ts, src/trace/distill.ts at 61e5f8b6). Pure presentation.
 *
 * Changed on purpose: the persona heading ("Stormforge finding") and the
 * thor-oracle / stormforge default tags are dropped (no profile registry in
 * v4, AGENTS rule 4); evidence with a URL becomes a `supports` url link and
 * repo + issue a `discusses` issue link, instead of only prose.
 *
 * v3 saved the note whatever its evidence held, so a link is made only from a
 * target the kernel's own grammar accepts (`contracts/evidence-v1.ts`
 * `requireUrl`, `normalizeRepo`). Anything else stays in the body and is
 * returned in `dropped`, for a `partial` warning, instead of refusing the
 * whole note at publish.
 */

type Evidence = { summary: string; path?: string; title?: string; url?: string; field: string };
type Dropped = { field: string; reason: string };

const text = (value: unknown): string | undefined => (typeof value === "string" ? value.trim() || undefined : undefined);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter((v): v is string => v !== undefined) : []);
const evidence = (value: unknown, name: string): Evidence[] =>
  (Array.isArray(value) ? value : []).flatMap((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
    const r = raw as Record<string, unknown>;
    const summary = text(r.summary);
    if (summary === undefined) return [];
    return [{ summary, path: text(r.path), title: text(r.title), url: text(r.url), field: `${name}/${index}/url` }];
  });
/** The kernel's refusal text for a target component, or null when it is accepted. */
const refusal = (check: () => unknown): string | null => {
  try {
    check();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const section = (title: string, values: string[]) => (values.length > 0 ? [`### ${title}`, "", ...values.map((v) => `- ${v}`), ""] : []);
const lines = (items: Evidence[], kind: "repo" | "external") =>
  items.map((item) => `- ${(kind === "repo" ? item.path : item.title ?? item.url) ?? "evidence"}${item.url && kind === "external" ? ` (${item.url})` : ""}: ${item.summary}`);

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function renderResearchNote(args: Record<string, unknown>): {
  title: string;
  body: string;
  links: Record<string, unknown>[];
  dropped: Dropped[];
  repo?: string;
} {
  const title = text(args.title) ?? "";
  const repo = text(args.repo);
  const issue = typeof args.issue === "number" && Number.isSafeInteger(args.issue) && args.issue > 0 ? args.issue : undefined;
  const repoEvidence = evidence(args.repoEvidence, "repoEvidence");
  const externalSources = evidence(args.externalSources, "externalSources");
  const recommendation = text(args.recommendation);
  const question = text(args.question);

  const finding = [
    "## Research finding",
    "",
    ...(question ? ["### Question", "", question, ""] : []),
    ...(issue ? [`- Issue: #${issue}`] : []),
    ...(repo ? [`- Repo: ${repo}`] : []),
    ...(issue || repo ? [""] : []),
    ...section("Repo evidence", lines(repoEvidence, "repo").map((l) => l.slice(2))),
    ...section("External sources", lines(externalSources, "external").map((l) => l.slice(2))),
    ...section("Hypotheses", list(args.hypotheses)),
    ...(recommendation ? ["### Recommendation", "", recommendation, ""] : []),
    ...section("Implementation plan", list(args.implementationPlan)),
    ...section("Verification plan", list(args.verificationPlan)),
    ...section("Open questions", list(args.openQuestions)),
  ].join("\n").trim();

  const blank = { content_hash: null, captured_at: null, capture_status: "locator_only" };
  const links: Record<string, unknown>[] = [];
  const dropped: Dropped[] = [];
  for (const item of [...repoEvidence, ...externalSources]) {
    if (item.url === undefined) continue;
    const reason = refusal(() => requireUrl(item.url!, []));
    if (reason !== null) {
      dropped.push({ field: item.field, reason });
      continue;
    }
    links.push({ relation: "supports", target_kind: "url", target: { url: item.url }, excerpt: item.summary, note: item.title ?? null, ...blank });
  }
  if (repo !== undefined && REPO.test(repo) && issue !== undefined) {
    const url = `https://github.com/${repo}/issues/${issue}`;
    const reason = refusal(() => (normalizeRepo(repo, []), requireUrl(url, [])));
    if (reason !== null) dropped.push({ field: "repo", reason });
    else links.push({ relation: "discusses", target_kind: "issue", target: { repo, number: String(issue), url }, excerpt: null, note: null, ...blank });
  }
  return { title, body: [title, finding].filter(Boolean).join("\n\n"), links, dropped, repo };
}
