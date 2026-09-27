import { type BODY_FORMATS, type PublishInput } from "../api/knowledge";
import { buildLinkSnapshot } from "./buildLinkSnapshot";
import type { LinkDraft } from "./linkDraft.types";

export type CorrectionRequest = {
  /** Caller-minted nanoid21 for the NEW correction node. */
  newNodeId: string;
  /** The exact accepted revision being corrected; `null` for a draft. */
  corrected: { node_id: string; revision_id: string } | null;
  title: string;
  body: string;
  body_format: (typeof BODY_FORMATS)[number];
  change_reason: string;
  extraLinks: LinkDraft[];
};

export type BuiltCorrection = { ok: true; input: PublishInput } | { ok: false; errors: string[] };

/** The #33 AC1 "correct" payload, as the taxonomy and evidence contracts
 *  define a correction -- not a generic save:
 *
 *   - a NEW node, first revision (`base_revision_id: null`). The corrected
 *     revision is immutable and is not edited; the correction sits beside it.
 *   - type term `correction`, one of the five sealed TYPE_TERMS. The type
 *     vocabulary is sealed on every transport (DECISIONS R6), so the UI can
 *     only pick an existing term, and `conclusion` is a different reserved
 *     term (R10) that this action never uses.
 *   - link 0 is `corrects` -> `node_revision`, pinned to the exact
 *     `(node_id, revision_id)` shown, so it keeps pointing at what was wrong
 *     even after that node is revised again. `scanDependents` then shows the
 *     correction as reverse evidence on the corrected revision.
 *   - any extra evidence follows from position 1. */
export function buildCorrection(req: CorrectionRequest): BuiltCorrection {
  const errors: string[] = [];
  if (req.corrected === null) errors.push("nothing to correct yet: publish this node first");
  else if (req.corrected.node_id === req.newNodeId) errors.push("a correction is a new node, not the node it corrects");
  if (req.title === "") errors.push("title is required");
  if (req.body === "") errors.push("body is required");
  const extra = buildLinkSnapshot(req.extraLinks, 1);
  if (!extra.ok) errors.push(...extra.errors);
  if (errors.length > 0 || req.corrected === null || !extra.ok) return { ok: false, errors };

  return {
    ok: true,
    input: {
      node_id: req.newNodeId,
      base_revision_id: null,
      title: req.title,
      body: req.body,
      body_format: req.body_format,
      type_term: "correction",
      horizon: null,
      author_peer_name: null,
      session_name: null,
      change_reason: req.change_reason === "" ? null : req.change_reason,
      links: [
        {
          position: "0",
          relation: "corrects",
          target_kind: "node_revision",
          target: { node_id: req.corrected.node_id, revision_id: req.corrected.revision_id },
          excerpt: null,
          content_hash: null,
          captured_at: null,
          capture_status: "locator_only",
          note: null,
        },
        ...extra.entries,
      ],
    },
  };
}
