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

/** `PublishForm`'s submit payload, pulled out so the shape of the outgoing
 *  draft is a plain function a test can call directly -- no DOM, no click
 *  simulation needed. This function only maps `links` straight through
 *  (`buildPublishInput.test.ts` is an identity check on that mapping); it
 *  cannot see whether the CALL SITE in `PublishForm.tsx` passes the link
 *  editor's real `built.entries` or drops them to `[]` -- that wiring is
 *  pinned by `citeCorrect.test.ts` ("submit sends the link editor's built
 *  entries…" and "a corrects link on type: correction is accepted"), which
 *  render `PublishForm` itself and read what actually reaches `onPublish`.
 *  Fix round (2026-09-27): an earlier doc comment here wrongly claimed this
 *  file's own test caught that mutant; it does not, and cannot. */
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
