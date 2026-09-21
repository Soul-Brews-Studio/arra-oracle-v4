import { type ChatContextItem, type ContextResult, type ExcludedContextItem, MAX_CONTEXT_WIRE_BYTES, MAX_LINKED_SESSIONS, contextItemWireBytes, parseGetContext, projectContextItem } from "./chat";
import { MESSAGE_FIELDS as MESSAGE_FIELDS_LOCAL, encodeMessageRow } from "./context";
import { PublicationError, failPublication } from "./errors";
import { SESSION_LINK_FIELDS, encodeSessionLinkRow } from "./session-link";
import { quote } from "./storage";
import { MESSAGES, SESSIONS, SESSION_LINKS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function getContext(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<ContextResult> {
const request = parseGetContext(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(SESSIONS);
      const session = await contextOne(
        reader,
        SESSIONS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
      );
      if (session === null) failPublication("invalid_reference", "/session_name");
      // The requester itself must hold a real, CURRENT membership in the
      // requested session: context assembly is not a backdoor around the
      // same membership rule appendMessages already enforces.
      await requireCurrentMembership(
        reader,
        request.workspace_name,
        request.session_name,
        request.peer_name,
        "/peer_name",
      );

      await reader.refresh(SESSION_LINKS);
      const linkRows = await reader.orderedProjection(
        SESSION_LINKS,
        `${contextScope(request.workspace_name)} AND from_session_name = ${quote(request.session_name)}`,
        SESSION_LINK_FIELDS as unknown as string[],
        { column: "id", ascending: true },
        MAX_LINKED_SESSIONS + 1,
      );
      const linkedSessions = new Set<string>();
      for (const row of linkRows.slice(0, MAX_LINKED_SESSIONS)) {
        const encodedLink = encodeSessionLinkRow(row);
        linkedSessions.add(encodedLink.to_session_name as string);
      }
      const candidateSessions = [request.session_name, ...linkedSessions];

      await reader.refresh(MESSAGES);
      type Candidate = { row: Record<string, unknown>; sessionName: string };
      const candidates: Candidate[] = [];
      for (const sessionName of candidateSessions) {
        const rows = await reader.orderedProjection(
          MESSAGES,
          `${contextScope(request.workspace_name)} AND session_name = ${quote(sessionName)}`,
          MESSAGE_FIELDS_LOCAL as unknown as string[],
          { column: "seq_in_session", ascending: false },
          request.max_items + 1,
        );
        for (const row of rows) candidates.push({ row, sessionName });
      }
      // Most recent overall first. `created_at` is the only column
      // comparable ACROSS sessions; `seq_in_session` is scoped to one
      // session only. Ties break on `public_id` for a deterministic order.
      candidates.sort((a, b) => {
        const av = a.row.created_at;
        const bv = b.row.created_at;
        if (typeof av !== "bigint" || typeof bv !== "bigint") failPublication("integrity_failure", "");
        if (av !== bv) return bv > av ? 1 : -1;
        const ap = a.row.public_id;
        const bp = b.row.public_id;
        if (typeof ap !== "string" || typeof bp !== "string") failPublication("integrity_failure", "");
        return ap < bp ? -1 : ap > bp ? 1 : 0;
      });

      const items: ChatContextItem[] = [];
      const excluded: ExcludedContextItem[] = [];
      let budget = 2; // brackets, matching the rest of this file's convention.
      let budgetExceeded = false;
      for (const candidate of candidates) {
        const encoded = encodeMessageRow(candidate.row);
        const publicId = encoded.public_id as string;
        if (items.length >= request.max_items) {
          budgetExceeded = true;
          excluded.push({ reason: "budget_exceeded", session_name: candidate.sessionName, public_id: publicId });
          continue;
        }
        // PER-ITEM authorization, BEFORE this candidate is ever added to
        // `items` -- never merge-then-filter.
        try {
          await requireCurrentMembership(
            reader,
            request.workspace_name,
            candidate.sessionName,
            request.peer_name,
            "/peer_name",
          );
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== "invalid_reference") throw error;
          excluded.push({ reason: "unauthorized", session_name: candidate.sessionName, public_id: publicId });
          continue;
        }
        const item = projectContextItem(encoded);
        const wireBytes = contextItemWireBytes(item) + 1;
        if (budget + wireBytes > MAX_CONTEXT_WIRE_BYTES) {
          budgetExceeded = true;
          excluded.push({ reason: "budget_exceeded", session_name: candidate.sessionName, public_id: publicId });
          continue;
        }
        budget += wireBytes;
        items.push(item);
      }

      return { items, coverage: budgetExceeded ? "partial" : "full", excluded };
}
