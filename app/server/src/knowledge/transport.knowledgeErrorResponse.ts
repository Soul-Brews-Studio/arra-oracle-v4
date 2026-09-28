// Split from transport.ts (style-split4b, 2026-09-28).

/** True for any of this package's three closed error envelopes. */
type EnvelopeError = { readonly code: string; readonly path: string; toJSON(): unknown };

function isEnvelopeError(error: unknown): error is EnvelopeError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { path?: unknown }).path === "string" &&
    typeof (error as { toJSON?: unknown }).toJSON === "function"
  );
}

/**
 * One fixed status per known error code, across all three envelopes
 * (`arra-error/v1`, `arra-publication-error/v1`, `arra-taxonomy-error/v1`).
 * Codes are never invented here — only mapped to a transport status.
 */
const STATUS_FOR_CODE: Readonly<Record<string, number>> = Object.freeze({
  // arra-error/v1 (contracts/errors.ts) — all are wire/contract format faults.
  invalid_json: 400,
  duplicate_key: 400,
  invalid_unicode: 400,
  invalid_type: 400,
  missing_field: 400,
  unexpected_field: 400,
  invalid_value: 400,
  out_of_range: 400,
  unsupported_version: 400,
  snapshot_position: 400,
  digest_mismatch: 400,
  target_key_mismatch: 400,
  scope_mismatch: 400,
  worker_failure: 500,
  // arra-publication-error/v1 and arra-taxonomy-error/v1 share one code set.
  // `conflict` is only ever thrown by `failTaxonomy` (TAXONOMY_ERROR_CODES) --
  // it is NOT a member of PUBLICATION_ERROR_CODES, so this entry is reachable
  // only through the taxonomy envelope today, not the publication one. It
  // sits with this shared block anyway because both envelopes read the same
  // map by code string, and a future publication code named `conflict` would
  // land on the same, already-correct status without a second entry.
  invalid_request: 400,
  not_found: 404,
  invalid_reference: 400,
  conflict: 409,
  integrity_failure: 500,
  writer_unavailable: 503,
  unsupported_dataset: 400,
  recovery_required: 503,
  limit_exceeded: 413,
  // #87 / R3: the admitted caller's own authority does not cover the request.
  forbidden: 403,
  // #32 / R9: no chat model configured, or it could not answer. Never 500.
  model_unavailable: 503,
  // #30 / R20: the dataset's pinned embedding model is not the one serving
  // now. A state conflict an operator resolves by re-indexing, not a retry.
  embedding_profile_mismatch: 409,
});

/**
 * Map a thrown error onto its transport response, preserving the envelope
 * UNCHANGED. Returns null for anything that is not one of this package's
 * three closed error types, so the caller can fall back to a fixed generic
 * 500 without ever inventing a fourth envelope.
 */
export function knowledgeErrorResponse(error: unknown): Response | null {
  if (!isEnvelopeError(error)) return null;
  const status = STATUS_FOR_CODE[error.code] ?? 500;
  return new Response(JSON.stringify(error.toJSON()), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
