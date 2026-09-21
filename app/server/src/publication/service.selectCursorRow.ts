import { failPublication } from "./errors";
import { encodeReadCursorRow } from "./read-cursor";
import { READ_CURSORS, cursorKey } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { selectCursorMessage } from "./service.selectCursorMessage";
import { type DatasetAdapter } from "./service.types";

/**
 * The current cursor: raw micros retained alongside the wire row.
 *
 * The raw value is kept because the clock comparison is defined on
 * MICROSECONDS. Comparing rendered millisecond text would silently accept a
 * regression smaller than the rendering can show.
 */
export async function selectCursorRow(
  adapter: DatasetAdapter,
  request: { workspace_name: string; peer_name: string; session_name: string },
): Promise<{ encoded: Record<string, unknown>; rawMicros: bigint; seq: bigint | null } | null> {
  await adapter.refresh(READ_CURSORS);
  const row = await contextOne(
    adapter,
    READ_CURSORS,
    cursorKey(request.workspace_name, request.peer_name, request.session_name),
  );
  if (row === null) return null;
  const encoded = encodeReadCursorRow(row);
  const raw = row.last_read_at;
  const rawMicros =
    typeof raw === "bigint"
      ? raw
      : typeof raw === "number" && Number.isSafeInteger(raw)
        ? BigInt(raw)
        : failPublication("integrity_failure", "");
  let seq: bigint | null = null;
  if (encoded.last_read_message_id !== null) {
    // A retained pointer is dereferenced and fully validated. An orphan is
    // terminal through this interface rather than quietly readable.
    const message = await selectCursorMessage(
      adapter,
      request.workspace_name,
      request.session_name,
      encoded.last_read_message_id as string,
      { code: "integrity_failure", path: "" },
    );
    seq = message.seq;
  }
  return { encoded, rawMicros, seq };
}
