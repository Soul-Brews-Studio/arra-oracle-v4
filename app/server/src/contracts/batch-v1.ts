/**
 * `arra-contract-batch/v1` — pure batch dispatcher (no I/O).
 *
 * One request object in, one response object out. Framing/version/item
 * identities are validated first, then payloads in request order; the first
 * error wins and fails the WHOLE batch with no results. Contract errors are a
 * valid protocol exchange (`ok:false`), not a process failure.
 *
 * Contract: app/docs/contracts/revision-evidence-v1.md §7.
 */

import { ContractError, ERROR_VERSION, type ContractErrorShape, fail } from "./errors";
import { type JcsObject, type JcsValue, LIMITS, jsonByteLength, utf8ByteLength } from "./jcs";
import { hasOnlyPairedSurrogates } from "./jcs";
import { requireClosedObject, requireEnum, requireUnicodeString, type Tokens } from "./common";
import { revisionOp, verifyRevisionOp } from "./revision-v1";
import { targetOp, verifyTargetOp } from "./evidence-v1";
import { revisionReplayOp, sourceReplayOp } from "./replay-v1";

export const BATCH_VERSION = "arra-contract-batch/v1" as const;
export const OPS = ["revision", "verify_revision", "target", "verify_target", "source_replay", "revision_replay"] as const;
export type Op = (typeof OPS)[number];

export type BatchResultItem = { id: string; op: Op; value: unknown };
export type BatchSuccess = { version: typeof BATCH_VERSION; ok: true; results: BatchResultItem[]; error: null };
export type BatchFailure = { version: typeof BATCH_VERSION; ok: false; results: []; error: { item_id: string | null; detail: ContractErrorShape } };
export type BatchResponse = BatchSuccess | BatchFailure;

function failure(itemId: string | null, error: ContractError): BatchFailure {
  return { version: BATCH_VERSION, ok: false, results: [], error: { item_id: itemId, detail: error.toJSON() } };
}

function runOp(op: Op, payload: JcsValue): unknown {
  const tokens: Tokens = [];
  switch (op) {
    case "revision": {
      const p = requireClosedObject(payload, ["content"], tokens);
      return revisionOp(p.get("content")!, ["content"]);
    }
    case "verify_revision": {
      const p = requireClosedObject(payload, ["content", "content_digest"], tokens);
      return verifyRevisionOp(p.get("content")!, p.get("content_digest")!, tokens);
    }
    case "target": {
      const p = requireClosedObject(payload, ["workspace_name", "target_kind", "target"], tokens);
      return targetOp(p.get("workspace_name")!, p.get("target_kind")!, p.get("target")!, tokens);
    }
    case "verify_target": {
      const p = requireClosedObject(payload, ["workspace_name", "target_kind", "target_json", "target_key"], tokens);
      return verifyTargetOp(p.get("workspace_name")!, p.get("target_kind")!, p.get("target_json")!, p.get("target_key")!, tokens);
    }
    case "source_replay": {
      const p = requireClosedObject(payload, ["incoming", "existing"], tokens);
      return sourceReplayOp(p.get("incoming")!, p.get("existing")!, tokens);
    }
    case "revision_replay": {
      const p = requireClosedObject(payload, ["incoming", "existing"], tokens);
      return revisionReplayOp(p.get("incoming")!, p.get("existing")!, tokens);
    }
  }
}

/** Dispatch an already strictly-parsed request. Never throws for contract errors. */
/** Raw UTF-8 byte spans of each item's payload, keyed by item index, captured during the transport parse. */
export type RawPayloadSpans = Map<number, number>;

export function dispatchBatch(request: JcsValue, opts: { rawPayloadBytes?: RawPayloadSpans } = {}): BatchResponse {
  // ---- framing: whole-request pointer, item_id null ----
  let items: JcsValue[];
  try {
    const r = requireClosedObject(request, ["version", "items"], []);
    const version = requireUnicodeString(r.get("version")!, ["version"]);
    if (version !== BATCH_VERSION) fail("unsupported_version", ["version"], `expected ${BATCH_VERSION}`);
    const rawItems = r.get("items")!;
    if (!Array.isArray(rawItems)) fail("invalid_type", ["items"], "items must be an array");
    if (rawItems.length > LIMITS.maxBatchItems) fail("limit_exceeded", ["items"], `at most ${LIMITS.maxBatchItems} items`);
    items = rawItems;
  } catch (error) {
    if (error instanceof ContractError) return failure(null, error);
    throw error;
  }

  // ---- item identities: validated before any payload, item_id null until unique ----
  const parsed: Array<{ id: string; op: Op; payload: JcsValue }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    try {
      const it = requireClosedObject(items[i]!, ["id", "op", "payload"], ["items", i]);
      const id = requireUnicodeString(it.get("id")!, ["items", i, "id"]);
      if (id.length === 0) fail("invalid_value", ["items", i, "id"], "id must be nonempty");
      if (utf8ByteLength(id) > LIMITS.maxCorrelationIdBytes) fail("limit_exceeded", ["items", i, "id"], `id exceeds ${LIMITS.maxCorrelationIdBytes} UTF-8 bytes`);
      if (seen.has(id)) fail("invalid_value", ["items", i, "id"], "duplicate correlation id");
      seen.add(id);
      const op = requireEnum(it.get("op")!, OPS, ["items", i, "op"]);
      parsed.push({ id, op, payload: it.get("payload")! });
    } catch (error) {
      if (error instanceof ContractError) return failure(null, error);
      throw error;
    }
  }

  // ---- payloads, in request order; payload-relative pointers; first error wins ----
  const results: BatchResultItem[] = [];
  for (const [index, item] of parsed.entries()) {
    try {
      // §7: each payload is independently bounded at the per-document limit,
      // regardless of how much of the 16 MiB transport it sits inside. This is
      // a PAYLOAD error: it carries the item's validated id and the payload
      // root pointer "", and it is reached only after EVERY identity passed.
      //
      // MEASUREMENT BASIS. This is an INPUT RESOURCE bound, so when the raw
      // span is known (the worker captures it during the one strict transport
      // parse) it is what gets measured: a whitespace- or escape-heavy payload
      // over 1 MiB must not slip through because it happens to COMPACT below
      // the cap. Only a direct in-process caller, which never had a wire
      // representation, falls back to the compact size.
      const raw = opts.rawPayloadBytes?.get(index);
      const size = raw ?? jsonByteLength(item.payload);
      if (size > LIMITS.maxDocumentBytes) {
        fail("limit_exceeded", [], `payload is ${size} bytes (${raw === undefined ? "compact" : "raw"}); limit ${LIMITS.maxDocumentBytes}`);
      }
      results.push({ id: item.id, op: item.op, value: runOp(item.op, item.payload) });
    } catch (error) {
      if (error instanceof ContractError) return failure(item.id, error);
      throw error;
    }
  }
  return { version: BATCH_VERSION, ok: true, results, error: null };
}

/** Serialize a response as one JSON document. Plain framing, NOT canonicalization. */
export function encodeResponse(response: BatchResponse): string {
  return JSON.stringify(response);
}

export { ERROR_VERSION, hasOnlyPairedSurrogates, type JcsObject };
