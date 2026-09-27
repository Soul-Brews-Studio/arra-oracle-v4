/** Shared types for the #33 cite/correct link editor.
 *
 * The contract allows eleven target kinds (`contracts/evidence-v1.ts`
 * TARGET_KINDS). This editor offers the five whose identity a person can
 * name from inside this app -- another knowledge revision, a session
 * message, a session, a trace, a URL. The four `node_revision`/`message`/
 * `session`/`trace` kinds are the ones `service.validateLinkReferences.ts`
 * RESOLVES inside the workspace, so a typo comes back as `invalid_reference`
 * rather than being stored; `url` is a passive locator. The code/commit/
 * issue/discussion/relic kinds need a git OID or a capture digest a person
 * does not type, and are left to the CLI and MCP writers.
 */
import type { LinkRelation } from "../api/knowledge";

export const CITE_TARGET_KINDS = ["node_revision", "message", "session", "trace", "url"] as const;
export type CiteTargetKind = (typeof CITE_TARGET_KINDS)[number];

/** `contracts/evidence-v1.ts` TARGET_KEYS for the offered kinds, same order. */
export const CITE_TARGET_FIELDS: Record<CiteTargetKind, readonly string[]> = {
  node_revision: ["node_id", "revision_id"],
  message: ["session_name", "message_public_id"],
  session: ["session_name"],
  trace: ["trace_id"],
  url: ["url"],
};

/** One row of the editor, as typed. `fields` may hold keys of a kind the
 *  row used to be; only CITE_TARGET_FIELDS[target_kind] are ever sent. */
export type LinkDraft = {
  relation: LinkRelation;
  target_kind: CiteTargetKind;
  fields: Record<string, string>;
  note: string;
};

/** A revision the UI has already loaded, offered as a pick in the editor. */
export type CiteTarget = { node_id: string; revision_id: string; revision_no: string; title: string };
