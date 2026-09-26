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
      // The `+ 1` lookahead row is how a truncated link list is DETECTED
      // (#85). It used to be fetched and then dropped with no signal, so a
      // ninth linked session was never searched while `coverage` said "full".
      // Conservative on purpose: a ninth row that duplicates an earlier
      // target (duplicate from/to pairs are allowed by id) still reports the
      // bound, because refusing to guess beats a silent omission.
      const linksTruncated = linkRows.length > MAX_LINKED_SESSIONS;
      const linkedSessions = new Set<string>();
      for (const row of linkRows.slice(0, MAX_LINKED_SESSIONS)) {
        const encodedLink = encodeSessionLinkRow(row);
        linkedSessions.add(encodedLink.to_session_name as string);
      }

      // Authorization is decided PER SESSION, once, BEFORE any message row
      // of that session is read -- never merge-then-filter. The anchor was
      // proven above. This used to run per candidate, AFTER the max_items
      // gate, so an unauthorized candidate past the cap was recorded as
      // `budget_exceeded` with its public_id attached (#85, repro C), and a
      // call could cost up to 459 membership lookups instead of 9.
      const authorizedSessions = [request.session_name];
      const unauthorizedSessions: string[] = [];
      for (const sessionName of linkedSessions) {
        try {
          await requireCurrentMembership(reader, request.workspace_name, sessionName, request.peer_name, "/peer_name");
          authorizedSessions.push(sessionName);
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== "invalid_reference") throw error;
          unauthorizedSessions.push(sessionName);
        }
      }

      await reader.refresh(MESSAGES);
      // An unauthorized session is COUNTED, never read: the projection is the
      // ordering column alone, so no content and no identifier of a message
      // the requester may not see enters this process. The bound is the same
      // `max_items + 1` lookahead an authorized session gets.
      let unauthorizedCount = 0;
      for (const sessionName of unauthorizedSessions) {
        const rows = await reader.orderedProjection(
          MESSAGES,
          `${contextScope(request.workspace_name)} AND session_name = ${quote(sessionName)}`,
          ["seq_in_session"],
          { column: "seq_in_session", ascending: false },
          request.max_items + 1,
        );
        unauthorizedCount += rows.length;
      }

      type Candidate = { row: Record<string, unknown>; sessionName: string };
      const candidates: Candidate[] = [];
      for (const sessionName of authorizedSessions) {
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

      // `excluded` has its OWN byte bound: the same-sized MAX_CONTEXT_WIRE_BYTES
      // constant as `items`, but a separate budget (#85). `excluded` never
      // reaches the model (service.answerChat.ts renders `items` only); the
      // bound exists because the response itself must stay bounded -- it used
      // to reach ~156 KB (1 anchor + 8 linked sessions x (max_items+1) entries).
      //
      // Recording STOPS at the bound rather than throwing: `limit_exceeded` is
      // right for the sibling list reads, which owe the caller a complete page
      // or nothing, but this result is allowed to "keep going with what it
      // has" -- a diagnostic list must not destroy the payload it describes.
      // Entries past the bound are COUNTED in `excluded_omitted`, the list's
      // own truncation signal; it no longer borrows `coverage` for that.
      //
      // The two fixed entries go first, so they can never be the ones
      // omitted: one anonymous unauthorized count (R4: listing those items by
      // public_id/session_name was the leak), then the link bound.
      const excluded: ExcludedContextItem[] = [];
      let excludedBytes = 2; // brackets, matching the rest of this file's convention.
      let excludedOmitted = 0;
      const recordExcluded = (entry: ExcludedContextItem): void => {
        const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
        if (excludedBytes + entryBytes > MAX_CONTEXT_WIRE_BYTES) {
          excludedOmitted++;
          return;
        }
        excludedBytes += entryBytes;
        excluded.push(entry);
      };
      if (unauthorizedCount > 0) recordExcluded({ reason: "unauthorized", count: unauthorizedCount });
      if (linksTruncated) recordExcluded({ reason: "budget_exceeded", session_name: null, public_id: null });

      const items: ChatContextItem[] = [];
      let budget = 2; // brackets, matching the rest of this file's convention.
      for (const candidate of candidates) {
        const encoded = encodeMessageRow(candidate.row);
        const publicId = encoded.public_id as string;
        if (items.length >= request.max_items) {
          recordExcluded({ reason: "budget_exceeded", session_name: candidate.sessionName, public_id: publicId });
          continue;
        }
        const item = projectContextItem(encoded);
        const wireBytes = contextItemWireBytes(item) + 1;
        if (budget + wireBytes > MAX_CONTEXT_WIRE_BYTES) {
          recordExcluded({ reason: "budget_exceeded", session_name: candidate.sessionName, public_id: publicId });
          continue;
        }
        budget += wireBytes;
        items.push(item);
      }

      // #85, overnight ruling R4 (docs/overnight/DECISIONS.md): "full" means
      // COMPLETE -- nothing excluded for any reason, authorization included.
      const complete = excluded.length === 0 && excludedOmitted === 0;
      return { items, coverage: complete ? "full" : "partial", excluded, excluded_omitted: excludedOmitted };
}
