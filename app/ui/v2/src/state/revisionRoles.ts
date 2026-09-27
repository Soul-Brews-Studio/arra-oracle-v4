import type { RevisionRow } from "../api/knowledge";

export type RevisionRole = "author" | "observer" | "subject";

/** One role of a revision, ready to render. `text` is the peer name, or the
 *  role's own "no <role> recorded" -- never another role's peer. */
export type RoleView = { role: RevisionRole; peer: string | null; recorded: boolean; text: string };

/** #33 design revision 2: author, observer and subject are three DIFFERENT
 *  claims (who wrote it, whose perspective it is, who it is about), carried
 *  by three nullable columns the publisher resolves as given -- no inference
 *  of the principal into them (revision-publication-v1). So they render as
 *  three labelled rows, never folded into one "by", and a null stays a
 *  visible absence rather than a hidden row. */
export function revisionRoles(
  revision: Pick<RevisionRow, "author_peer_name" | "observer_peer_name" | "subject_peer_name">,
): RoleView[] {
  const role = (r: RevisionRole, peer: string | null): RoleView => ({
    role: r,
    peer,
    recorded: peer !== null,
    text: peer ?? `no ${r} recorded`,
  });
  return [
    role("author", revision.author_peer_name),
    role("observer", revision.observer_peer_name),
    role("subject", revision.subject_peer_name),
  ];
}
