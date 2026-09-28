/**
 * Session links v1 -- the PURE half.
 *
 * Contract: app/docs/contracts/session-link-v1.md
 * SHA256 9a0235d7279d3a8ee56bbb83aac70b2eb769db507b24e591bf7ef80e024c6784
 * (Soul-Brews-Studio/arra-oracle-v4#28)
 *
 * Request grammar and the stored-row codec, with no SDK, connection or owner
 * import. Everything here is decidable from bytes alone.
 *
 * TWO envelopes, neither new:
 *   - governed ContractError / arra-error/v1 for parse, shape and value.
 *   - PublicationError / arra-publication-error/v1 for STORED-state failures,
 *     always at the ROOT path (`""`).
 *
 * Split (Nat style, one exported function per file, style-split5a #22): this
 * file is now a re-export barrel so importers and any citation of
 * `server/src/publication/session-link.ts` do not churn. The three functions
 * live in session-link.parseCreateSessionLink.ts,
 * session-link.parseListSessionLinks.ts and
 * session-link.encodeSessionLinkRow.ts; shared constants live in
 * session-link.constants.ts; shared private helpers used by more than one
 * split file each got their own single-export file
 * (session-link.parseRequest.ts, session-link.name.ts, session-link.id.ts).
 * Split files import each other directly, never through this barrel.
 */
export {
  MAX_PAGE_LIMIT,
  MAX_RESULT_WIRE_BYTES,
  MAX_CYCLE_VISITED,
  SESSION_LINK_FIELDS,
  SESSION_RELATIONS,
  type SessionRelation,
  DIRECTED_SESSION_RELATIONS,
  SESSION_LINK_DIRECTIONS,
  type SessionLinkDirection,
} from "./session-link.constants";
export {
  type CreateSessionLinkRequest,
  parseCreateSessionLink,
} from "./session-link.parseCreateSessionLink";
export {
  type ListSessionLinksRequest,
  parseListSessionLinks,
} from "./session-link.parseListSessionLinks";
export { encodeSessionLinkRow } from "./session-link.encodeSessionLinkRow";
