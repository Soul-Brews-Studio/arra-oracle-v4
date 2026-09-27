import type { LinkSnapshotEntry } from "../api/knowledge";
import { CITE_TARGET_FIELDS, type LinkDraft } from "./linkDraft.types";
import { validateLinkDraft } from "./validateLinkDraft";

export type BuiltLinks = { ok: true; entries: LinkSnapshotEntry[] } | { ok: false; errors: string[] };

/** Editor rows -> `link_snapshot_json` entries (#33 AC1 "cite").
 *
 * Positions are contiguous decimal strings from `startPosition`, the only
 * spelling `normalizeLinks` accepts (Int64 as canonical text, `"0".."n-1"`).
 * A correction reserves position 0 for its own `corrects` link and passes 1.
 * `target` carries exactly the kind's TARGET_KEYS -- a row switched from
 * `message` to `session` keeps its typed `message_public_id` locally, but it
 * is never sent, because the server's closed object would refuse it.
 * One bad row fails the whole build: publishing a revision with some of its
 * evidence silently dropped would be worse than not publishing. */
export function buildLinkSnapshot(drafts: LinkDraft[], startPosition = 0): BuiltLinks {
  const errors: string[] = [];
  const entries: LinkSnapshotEntry[] = [];
  drafts.forEach((draft, i) => {
    const problems = validateLinkDraft(draft);
    if (problems.length > 0) {
      errors.push(`link ${i + 1 + startPosition}: ${problems.join("; ")}`);
      return;
    }
    const target: Record<string, string> = {};
    for (const field of CITE_TARGET_FIELDS[draft.target_kind]) target[field] = draft.fields[field] ?? "";
    entries.push({
      position: String(startPosition + entries.length),
      relation: draft.relation,
      target_kind: draft.target_kind,
      target,
      excerpt: null,
      content_hash: null,
      captured_at: null,
      capture_status: "locator_only",
      note: draft.note === "" ? null : draft.note,
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}
