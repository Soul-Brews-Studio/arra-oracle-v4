import { encodeMessageRow } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { MESSAGES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * Select one message by the declared namespace and prove its identity.
 *
 * `fault` separates the two callers: a REQUEST pointer that does not resolve
 * is the caller's invalid_reference, while a RETAINED pointer that does not
 * resolve is stored corruption at root. Same lookup, different authorship.
 */
export async function selectCursorMessage(
  adapter: DatasetAdapter,
  workspace: string,
  sessionName: string,
  publicId: string,
  fault: { code: "invalid_reference" | "integrity_failure" | "recovery_required"; path: string },
): Promise<{ encoded: Record<string, unknown>; seq: bigint }> {
  await adapter.refresh(MESSAGES);
  // limit 2 inside contextOne: a duplicate public_id is integrity_failure, not
  // a first-match guess.
  const row = await contextOne(
    adapter,
    MESSAGES,
    `${contextScope(workspace)} AND public_id = ${quote(publicId)}`,
  );
  if (row === null) failPublication(fault.code, fault.path);
  const encoded = encodeMessageRow(row);
  // The message must belong to the REQUESTED session. A cross-session pointer
  // is not a cursor into this session's history.
  if (encoded.session_name !== sessionName) failPublication(fault.code, fault.path);

  const seqText = encoded.seq_in_session;
  if (typeof seqText !== "string") failPublication("integrity_failure", "");
  const seq = BigInt(seqText);
  // The selected ORDINAL must also be unique and must name the same row.
  // Only selected identities are checked: no corpus audit, no global max.
  const bySeq = await contextOne(
    adapter,
    MESSAGES,
    `${contextScope(workspace)} AND session_name = ${quote(sessionName)} AND seq_in_session = ${seq.toString(10)}`,
  );
  if (bySeq === null) failPublication("integrity_failure", "");
  // Exactly ONE SAME row, compared on its FULL encoded state rather than a
  // single field: a second row agreeing on public_id while differing in its
  // legacy id, author or content is still two different messages.
  const bySeqEncoded = encodeMessageRow(bySeq);
  for (const field of Object.keys(encoded)) {
    if (bySeqEncoded[field] !== encoded[field]) failPublication("integrity_failure", "");
  }
  return { encoded, seq };
}
