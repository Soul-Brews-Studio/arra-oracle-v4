import { MAX_RESULT_WIRE_BYTES, encodeMessageRow, rowWireBytes } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { MESSAGES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * One keyset page of a session's messages, in either direction (K11,
 * overnight R18). Moved out of `listMessages` unchanged for the ascending
 * read, so both directions share one validator:
 *
 *  - ascending: `seq_in_session > cursor`, oldest first (the original read);
 *  - descending: `seq_in_session < cursor`, newest first -- "the last N" is
 *    one page instead of a walk from the start.
 *
 * KEYSET, never offset: limit+1 detects continuation without paging by
 * position, which would skip or repeat rows as the table grows. `next` is the
 * last emitted sequence when another row exists, else null.
 */
export async function selectMessagePage(
  reader: DatasetAdapter,
  workspace: string,
  session: string,
  cursor: bigint | null,
  descending: boolean,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; next: string | null }> {
  await reader.refresh(MESSAGES);
  const scope =
    `${contextScope(workspace)} AND session_name = ${quote(session)}` +
    (cursor === null ? "" : ` AND seq_in_session ${descending ? "<" : ">"} ${cursor.toString(10)}`);
  const selected = await reader.orderedProjection(
    MESSAGES,
    scope,
    ["seq_in_session", "public_id"],
    { column: "seq_in_session", ascending: !descending },
    limit + 1,
  );

  const keys: bigint[] = [];
  const publicIds = new Set<string>();
  for (const row of selected) {
    const seq = row.seq_in_session;
    if (typeof seq !== "bigint") failPublication("integrity_failure", "");
    // The LOOKAHEAD row is validated too, not just the emitted page: a
    // duplicate straddling the limit would otherwise evade the check and
    // split silently across two pages.
    if (keys.some((k) => k === seq)) failPublication("integrity_failure", "");
    keys.push(seq);
    const publicId = row.public_id;
    if (typeof publicId !== "string") failPublication("integrity_failure", "");
    if (publicIds.has(publicId)) failPublication("integrity_failure", "");
    publicIds.add(publicId);
  }

  const page = keys.slice(0, limit);
  const rows: Record<string, unknown>[] = [];
  // Brackets plus one comma per row: sum + n + 1.
  let budget = 1;
  for (const seq of page) {
    const row = await contextOne(
      reader,
      MESSAGES,
      `${contextScope(workspace)} AND session_name = ${quote(session)} AND seq_in_session = ${seq.toString(10)}`,
    );
    if (row === null) failPublication("integrity_failure", "");
    const encoded = encodeMessageRow(row);
    budget += rowWireBytes(encoded) + 1;
    // Cumulative wire budget. Over budget fails; it never truncates, which
    // would hand back a short page indistinguishable from a real one.
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(encoded);
  }

  const hasMore = keys.length > limit;
  return { rows, next: hasMore && page.length > 0 ? page[page.length - 1]!.toString(10) : null };
}
