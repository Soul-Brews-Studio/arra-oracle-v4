import { MAX_RESULT_WIRE_BYTES, type RequestAuthority, encodeMessageRow, parseListMessages, requireMessageReadAuthority, rowWireBytes } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { MESSAGES, SESSIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * #87 / R3 (docs/overnight/DECISIONS.md): membership is a read boundary here.
 * A named `requester_peer_name` must hold CURRENT membership of the session --
 * the same `requireCurrentMembership` getContext applies, so a departed member
 * is refused exactly like a stranger. With no requester, only the audit:read
 * operator view in `authority` may read; that is decided before any storage.
 */
export async function listMessages(reader: DatasetAdapter, requestBytes: Uint8Array, authority: RequestAuthority): Promise<{ rows: Record<string, unknown>[]; next_after_seq: string | null }> {
const request = parseListMessages(requestBytes);
      requireMessageReadAuthority(request.requester_peer_name, authority);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(SESSIONS);
      const session = await contextOne(
        reader,
        SESSIONS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
      );
      if (session === null) failPublication("invalid_reference", "/session_name");
      // Session existence is not secret (listSessions shows it to any
      // content:read holder), so refusing a non-member here, AFTER the
      // session check, reveals nothing a caller could not already list.
      if (request.requester_peer_name !== null) {
        await requireCurrentMembership(
          reader,
          request.workspace_name,
          request.session_name,
          request.requester_peer_name,
          "/requester_peer_name",
        );
      }

      await reader.refresh(MESSAGES);
      const after = request.after_seq === null ? null : BigInt(request.after_seq);
      const scope =
        `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
        (after === null ? "" : ` AND seq_in_session > ${after.toString(10)}`);

      // KEYSET, never offset: limit+1 detects continuation without paging by
      // position, which would skip or repeat rows as the table grows.
      const selected = await reader.orderedProjection(
        MESSAGES,
        scope,
        ["seq_in_session", "public_id"],
        { column: "seq_in_session", ascending: true },
        request.limit + 1,
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

      const page = keys.slice(0, request.limit);
      const rows: Record<string, unknown>[] = [];
      // Brackets plus one comma per row: sum + n + 1.
      let budget = 1;
      for (const seq of page) {
        const row = await contextOne(
          reader,
          MESSAGES,
          `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)} AND seq_in_session = ${seq.toString(10)}`,
        );
        if (row === null) failPublication("integrity_failure", "");
        const encoded = encodeMessageRow(row);
        budget += rowWireBytes(encoded) + 1;
        // Cumulative wire budget. Over budget fails; it never truncates, which
        // would hand back a short page indistinguishable from a real one.
        if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
        rows.push(encoded);
      }

      const hasMore = keys.length > request.limit;
      return {
        rows,
        next_after_seq: hasMore && page.length > 0 ? page[page.length - 1]!.toString(10) : null,
      };
}
