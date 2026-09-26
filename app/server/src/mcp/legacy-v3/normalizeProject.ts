/**
 * A v3 `project` argument as a `project` term name (V3-PARITY.md §4.3):
 * `https://github.com/o/r`, `github.com/o/r`, `o/r` and `o/r.git` all become
 * `o/r`, lowercased as `contracts/evidence-v1.ts` normalizes a GitHub repo.
 * Nothing becomes `_universal`, v3's own convention. cwd is never consulted
 * (AGENTS.md:30: adjacency does not prove ownership).
 */
export function normalizeProject(value: unknown): string {
  if (typeof value !== "string") return "_universal";
  const bare = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return bare === "" ? "_universal" : bare;
}
