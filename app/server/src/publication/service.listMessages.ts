import { type RequestAuthority, parseListMessages, requireMessageReadAuthority } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { SESSIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { requireWorkspace } from "./service.requireWorkspace";
import { selectMessagePage } from "./service.selectMessagePage";
import { type DatasetAdapter } from "./service.types";

/**
 * #87 / R3 (docs/overnight/DECISIONS.md): membership is a read boundary here.
 * A named `requester_peer_name` must hold CURRENT membership of the session --
 * the same `requireCurrentMembership` getContext applies, so a departed member
 * is refused exactly like a stranger. With no requester, only the audit:read
 * operator view in `authority` may read; that is decided before any storage.
 *
 * K11 (overnight R18): `direction:"desc"` reads the same page newest first,
 * paged by `before_seq`, and answers `{rows, next_before_seq}`; an ascending
 * read answers `{rows, next_after_seq}` exactly as before. The boundary above
 * is identical for both.
 */
export async function listMessages(
  reader: DatasetAdapter,
  requestBytes: Uint8Array,
  authority: RequestAuthority,
): Promise<{ rows: Record<string, unknown>[]; next_after_seq: string | null } | { rows: Record<string, unknown>[]; next_before_seq: string | null }> {
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

      const descending = request.direction === "desc";
      const cursor = descending ? request.before_seq : request.after_seq;
      const page = await selectMessagePage(
        reader,
        request.workspace_name,
        request.session_name,
        cursor === null ? null : BigInt(cursor),
        descending,
        request.limit,
      );
      return descending ? { rows: page.rows, next_before_seq: page.next } : { rows: page.rows, next_after_seq: page.next };
}
