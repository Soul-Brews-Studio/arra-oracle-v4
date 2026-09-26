/**
 * The display title a session carries in `h_metadata` (K12a), or null. Display
 * data only: anything that is not `{"title": string}` -- another writer's
 * metadata, or none -- reads as no title, never as an error.
 */
export function threadTitle(row: Record<string, unknown>): string | null {
  if (typeof row.h_metadata !== "string") return null;
  try {
    const parsed = JSON.parse(row.h_metadata) as { title?: unknown } | null;
    return typeof parsed?.title === "string" ? parsed.title : null;
  } catch {
    return null;
  }
}
