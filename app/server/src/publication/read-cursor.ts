/**
 * #71 (Parent #28) read cursors -- the PURE half.
 *
 * Contract: app/docs/contracts/read-cursor-v1.md
 * SHA256 04f553dd20f572d6bc9c83b1c8752e69018ff5556ad2b2b1b1308162ca82f24f
 *
 * Request grammar and the stored-row codec, with no SDK, connection or owner
 * import. Everything here is decidable from bytes alone.
 *
 * Split (Nat style, one exported function per file, style-split5a #22): this
 * file is now a re-export barrel so importers and any citation of
 * `server/src/publication/read-cursor.ts` do not churn. The four functions
 * live in read-cursor.parseGetReadCursor.ts, read-cursor.parseAdvanceReadCursor.ts,
 * read-cursor.validateWorkspaceRow.ts and read-cursor.encodeReadCursorRow.ts;
 * shared field-order constants live in read-cursor.constants.ts; shared
 * private helpers used by more than one split file each got their own
 * single-export file (read-cursor.parseRequest.ts, read-cursor.name.ts,
 * read-cursor.requireExactColumns.ts, read-cursor.storedText.ts,
 * read-cursor.storedName.ts, read-cursor.storedTimestamp.ts). Split files
 * import each other directly, never through this barrel.
 */
export { READ_CURSOR_FIELDS, WORKSPACE_FIELDS } from "./read-cursor.constants";
export { type GetReadCursorRequest, parseGetReadCursor } from "./read-cursor.parseGetReadCursor";
export {
  type AdvanceReadCursorRequest,
  parseAdvanceReadCursor,
} from "./read-cursor.parseAdvanceReadCursor";
export { validateWorkspaceRow } from "./read-cursor.validateWorkspaceRow";
export { encodeReadCursorRow } from "./read-cursor.encodeReadCursorRow";
