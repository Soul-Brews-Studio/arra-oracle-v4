export const LIMITS = Object.freeze({
  /** Per strict-parsed JSON document, in UTF-8 bytes. */
  maxDocumentBytes: 1 * 1024 * 1024,
  /** Root container = 1, each nested container +1, scalars add none. */
  maxDepth: 64,
  /** Whole batch request/response, in UTF-8 bytes (incl. optional final LF). */
  maxTransportBytes: 16 * 1024 * 1024,
  maxBatchItems: 64,
  maxStderrBytes: 64 * 1024,
  maxCorrelationIdBytes: 128,
});
