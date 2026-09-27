/** The KNOWLEDGE tier -- nodes, revisions, type and tags.
 *
 * This is the half of the system that is ours rather than Honcho's: a typed,
 * superseded-not-deleted knowledge store with a controlled taxonomy over it,
 * inherited from arra-oracle-v3. `memory.ts` covers the Honcho half.
 *
 * ---------------------------------------------------------------------------
 * Four wire details that are each a silent refusal if you get them wrong, all
 * verified against the running server rather than read off the types:
 *
 *  1. `fields`, `term_snapshot_json`, `link_snapshot_json`, `h_metadata` and
 *     `internal_metadata` are JSON **strings**, not objects. Sending `{}`
 *     earns `invalid_type at /content/fields: expected string`. They are
 *     stored columns that happen to hold JSON, so the envelope carries their
 *     TEXT.
 *  2. `position` inside a term snapshot is an Int64, and Int64 crosses this
 *     wire as a canonical decimal STRING. `0` earns `int64 must be a
 *     canonical decimal string`; `"0"` is accepted.
 *  3. A revision must carry exactly one `type` term. The `type` vocabulary is
 *     `required: true, cardinality: one, term_policy: sealed`, so an empty
 *     `term_snapshot_json` fails with `integrity_failure`, not a friendlier
 *     "missing type". Seed the vocabularies before publishing anything.
 *  4. `node_id`, `operation_id`, every `vocabulary_id` and every `term_id`
 *     are CALLER-MINTED nanoid21. The server does not allocate them.
 *
 * That last point is what makes this tier reachable at all. Issue #88 says
 * `getAcceptedHead` is "wired but unreachable -- nothing in the transport
 * returns a bare node_id a caller could capture", which is true for
 * DISCOVERY: you cannot browse to a node somebody else made. It is not true
 * for a client that mints its own ids and remembers them, which is the same
 * bookmark pattern `state/roster.ts` already uses for peers and sessions.
 */

/** `taxonomy.constants.ts` TYPE_TERMS -- sealed, so this list is complete and
 *  cannot drift without a server change. Note `conclusion` is already here:
 *  issue #89 asks for a conclusion-shaped TABLE, and #36's answer was that a
 *  conclusion is a node of this type. The taxonomy kernel implements it. */
export const TYPE_TERMS = ["note", "conclusion", "learning", "discussion", "correction"] as const;
export type TypeTerm = (typeof TYPE_TERMS)[number];

/** `taxonomy.constants.ts` HORIZON_TERMS. This is how short-term vs long-term
 *  memory is expressed -- a controlled vocabulary term, deliberately NOT a
 *  column and deliberately not a decay score (issue #2 settled that). */
export const HORIZON_TERMS = ["short_term", "long_term"] as const;
export type HorizonTerm = (typeof HORIZON_TERMS)[number];

export const BODY_FORMATS = ["markdown", "text"] as const;

/** Pinned by `contracts/revision-v1.ts`; the server refuses any other value
 *  with `unsupported_version`, so these are constants and not settings. */
export const SCHEMA_VERSION = "1";
export const CANONICAL_VERSION = "arra-revision/v1";

export type TermSnapshot = {
  term_id: string;
  vocabulary_id: string;
  vocabulary_name_snapshot: string;
  term_name_snapshot: string;
  label_snapshot: string | null;
  /** Int64 as a canonical decimal string. See note 2 above. */
  position: string;
};

/** `contracts/revision-v1.ts` RELATIONS -- a closed enum; the server refuses
 *  any other value with `invalid_value` at `/relation`. */
export const LINK_RELATIONS = ["supports", "contradicts", "derived_from", "discusses", "corrects", "related_to"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** One `link_snapshot_json` entry, keys in `contracts/revision-v1.ts`
 *  LINK_KEYS order. `target` is the closed per-kind OBJECT from
 *  `contracts/evidence-v1.ts` TARGET_KEYS, not a second JSON string. This UI
 *  never fetches or hashes a target, so it only ever writes `locator_only`
 *  with null excerpt/hash/capture time -- `captured` would be a claim the
 *  server does not verify (`revision-evidence-v1.md` §4). */
export type LinkSnapshotEntry = {
  position: string;
  relation: LinkRelation;
  target_kind: string;
  target: Record<string, string>;
  excerpt: null;
  content_hash: null;
  captured_at: null;
  capture_status: "locator_only";
  note: string | null;
};

/** The ids minted when the reserved vocabularies were seeded. Held locally
 *  because `getVocabulary` and `getTerm` take IDS, not names -- there is no
 *  lookup from "type" to its vocabulary_id. */
export type TaxonomyIds = {
  type: { vocabulary_id: string; terms: Record<TypeTerm, string> };
  memory_horizon: { vocabulary_id: string; terms: Record<HorizonTerm, string> };
};

export type PublishInput = {
  node_id: string;
  /** `null` for a first revision; the previous revision id for an edit. The
   *  server rejects a base that is not this node's current head, which is how
   *  a lost update becomes a refusal instead of a silent overwrite. */
  base_revision_id: string | null;
  title: string;
  body: string;
  body_format: (typeof BODY_FORMATS)[number];
  type_term: TypeTerm;
  horizon: HorizonTerm | null;
  author_peer_name: string | null;
  session_name: string | null;
  change_reason: string | null;
  /** Evidence links, already built and position-ordered
   *  (`state/buildLinkSnapshot`). `[]` is a revision that cites nothing. */
  links: LinkSnapshotEntry[];
};

export type PublishOutcome = {
  outcome: string;
  node_id: string;
  revision_id: string;
  revision_no: string;
  content_digest: string;
};

/** The stored revision as `getAcceptedHead` and `listAcceptedHistory` return
 *  it. Verified against the wire: the row carries all 26 columns, including
 *  `content_digest` -- an earlier version of this type omitted it and a
 *  component correctly concluded from the type that the server did not send
 *  one. The type was wrong, not the server. */
export type RevisionRow = {
  id: string;
  node_id: string;
  revision_no: string;
  base_revision_id: string | null;
  operation_id: string;
  title: string;
  body: string;
  body_format: string;
  fields: string;
  author_peer_name: string | null;
  observer_peer_name: string | null;
  subject_peer_name: string | null;
  session_name: string | null;
  is_active: boolean;
  valid_from: string | null;
  valid_to: string | null;
  change_reason: string | null;
  created_at: string;
  schema_version: string;
  canonical_version: string;
  /** sha256 of the canonical envelope. This is what makes "same content"
   *  decidable without diffing two bodies, so it is worth surfacing. */
  content_digest: string;
  term_snapshot_json?: string;
  link_snapshot_json?: string;
};

// Functions split out (style-ui-split2, docs/overnight/DECISIONS.md): each
// lives in its own file named after itself. Re-exported here so importers
// (`publishRevision.test.ts`, `state/*`) do not churn.
export { mintTaxonomyIds } from "./knowledge.mintTaxonomyIds";
export { seedReservedVocabularies } from "./knowledge.seedReservedVocabularies";
export { getVocabulary } from "./knowledge.getVocabulary";
export { getTerm } from "./knowledge.getTerm";
export { getAcceptedHead } from "./knowledge.getAcceptedHead";
export { listAcceptedHistory } from "./knowledge.listAcceptedHistory";
export { getRevisionAssociations } from "./knowledge.getRevisionAssociations";
export { publishRevision } from "./knowledge.publishRevision";
export { parseTerms } from "./knowledge.parseTerms";
export { typeOf } from "./knowledge.typeOf";
export { horizonOf } from "./knowledge.horizonOf";
