import { excerptOf } from "./excerptOf";
import { termsOf } from "./termsOf";

const MAX_EXCERPT_CODE_POINTS = 500;

export type LifecycleEvent = { new_id: string | null; reason: string; superseded_at: string };

/**
 * `oracle_list`'s (and, minus the lifecycle flags, `oracle_inbox`'s preview)
 * v3 document shape (V3-PARITY.md §4.3 / §5): `{id, type, title, content,
 * source_file:null, concepts, indexed_at}`, plus `superseded_by`/
 * `superseded_at`/`superseded_reason` -- ONLY on a row that is not eligible
 * (`lifecycleEvent !== null`), matching `oracle_read`'s own additive fields
 * for the identical state. `type` prefers `legacy_type` over the reserved
 * `type` term, the same rule `oracle_supersede`'s `old_type`/`new_type`
 * states, so a v3-dialect type survives the round trip through v4's own.
 */
export function documentOf(
  row: Record<string, unknown>,
  head: { revision: Record<string, unknown> },
  lifecycleEvent: LifecycleEvent | null,
): Record<string, unknown> {
  const parsed = termsOf(head.revision.term_snapshot_json as string);
  const doc: Record<string, unknown> = {
    id: row.id,
    type: parsed.legacyType ?? parsed.type,
    title: head.revision.title,
    content: excerptOf(head.revision.body as string, MAX_EXCERPT_CODE_POINTS),
    source_file: null,
    concepts: parsed.concepts,
    indexed_at: Date.parse(row.updated_at as string),
  };
  if (lifecycleEvent !== null) {
    doc.superseded_by = lifecycleEvent.new_id;
    doc.superseded_at = lifecycleEvent.superseded_at;
    doc.superseded_reason = lifecycleEvent.reason;
  }
  return doc;
}
