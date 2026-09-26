export type HeadFacts = {
  title: string;
  body: string;
  /** v3's `type`: the `legacy_type` term when one was kept (R11), else the `type` term. */
  v3Type: string;
  concepts: string[];
  /** The `project` term, or null when the entry carries none (v3: project IS NULL). */
  project: string | null;
  /** getAcceptedHead's lifecycle label; non-null means retired or superseded. */
  lifecycle: unknown;
};

type Snapshot = { vocabulary_name_snapshot?: unknown; term_name_snapshot?: unknown };

/**
 * What a v3 recall result shows about one node, read from its accepted head
 * (`getAcceptedHead`): title, body, and the term snapshot the revision froze
 * at publish time, by the adapter's vocabulary names (D2: `type`, `concepts`,
 * `legacy_type`, `project`). Pure; null when there is no head.
 */
export function describeHead(head: unknown): HeadFacts | null {
  const found = head as { revision?: { title?: unknown; body?: unknown; term_snapshot_json?: unknown }; lifecycle?: unknown } | null;
  if (found === null || typeof found !== "object" || typeof found.revision !== "object" || found.revision === null) return null;
  let snapshot: Snapshot[] = [];
  try {
    const parsed = JSON.parse(typeof found.revision.term_snapshot_json === "string" ? found.revision.term_snapshot_json : "[]");
    if (Array.isArray(parsed)) snapshot = parsed;
  } catch {
    snapshot = [];
  }
  const names = (vocabulary: string) =>
    snapshot
      .filter((term) => term?.vocabulary_name_snapshot === vocabulary && typeof term.term_name_snapshot === "string")
      .map((term) => term.term_name_snapshot as string);
  return {
    title: typeof found.revision.title === "string" ? found.revision.title : "",
    body: typeof found.revision.body === "string" ? found.revision.body : "",
    v3Type: names("legacy_type")[0] ?? names("type")[0] ?? "unknown",
    concepts: names("concepts"),
    project: names("project")[0] ?? null,
    lifecycle: found.lifecycle ?? null,
  };
}
