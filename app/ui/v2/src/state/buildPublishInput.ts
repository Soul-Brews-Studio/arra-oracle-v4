import type { BODY_FORMATS, HorizonTerm, LinkSnapshotEntry, PublishInput, TypeTerm } from "../api/knowledge";

export type PublishFormFields = {
  title: string;
  body: string;
  bodyFormat: (typeof BODY_FORMATS)[number];
  typeTerm: TypeTerm;
  horizon: HorizonTerm | "none";
  changeReason: string;
};

export type PublishDraft = Omit<PublishInput, "node_id" | "base_revision_id">;

/** `PublishForm`'s submit payload, pulled out so the wiring between the
 *  link editor's built entries and the outgoing draft is a plain function a
 *  test can call directly -- no DOM, no click simulation needed. Wave 5
 *  hardening (#33): a mutant that drops `links` back to `[]` at the call
 *  site must turn `buildPublishInput.test.ts` red; see that file. */
export function buildPublishInput(fields: PublishFormFields, links: LinkSnapshotEntry[]): PublishDraft {
  return {
    title: fields.title,
    body: fields.body,
    body_format: fields.bodyFormat,
    type_term: fields.typeTerm,
    horizon: fields.horizon === "none" ? null : fields.horizon,
    change_reason: fields.changeReason === "" ? null : fields.changeReason,
    author_peer_name: null,
    session_name: null,
    links,
  };
}
