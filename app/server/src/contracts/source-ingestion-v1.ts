/**
 * Source ingestion and legacy boundary — candidate v1. PURE.
 *
 * Four raw-JSON-in, JSON-out validators for the message ingestion boundary.
 * They allocate no ID or sequence, read no clock, open no database, call no
 * model, and introduce no canonicalization of their own: the digest comes from
 * the ALREADY ACCEPTED `messageDigest` over its unchanged seven-field
 * `arra-message/v1` envelope, and replay classification comes from the
 * unchanged `sourceReplayOp`.
 *
 * Input is a raw JSON STRING on purpose. Duplicate decoded keys, invalid
 * Unicode, and size/depth limits are caught by the existing strict parser
 * before anything becomes a native object — a validator that accepted an
 * already-parsed object could not see any of those. It also keeps this module
 * distinguishable from the future authorized service that CONSTRUCTS that
 * input after authorization.
 *
 * What this module does NOT prove: authorization, durable ingestion, service
 * uniqueness, sequence allocation, writer exclusion, or dataset-wide collision
 * detection. Those are #25/#28/#34 gates.
 *
 * Contract: app/docs/contracts/source-ingestion-v1.md §8–§10.
 *
 * This file is a thin barrel: the implementation lives beside it as
 * `source-ingestion-v1.<functionName>.ts`, one function per file. Nothing
 * here changes behaviour.
 */

export { prepareNewMessage } from "./source-ingestion-v1.prepareNewMessage";
export { validateStoredSourceState } from "./source-ingestion-v1.validateStoredSourceState";
export { mapLegacyMessageBoundary } from "./source-ingestion-v1.mapLegacyMessageBoundary";
export { classifyMessageDestinationReplay } from "./source-ingestion-v1.classifyMessageDestinationReplay";
