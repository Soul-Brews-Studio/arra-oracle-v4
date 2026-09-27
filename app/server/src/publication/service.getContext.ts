import { type ChatContextItem, type ContextResult, type ExcludedContextItem, MAX_CONTEXT_WIRE_BYTES, MAX_LINKED_SESSIONS, contextItemWireBytes, parseGetContext, projectContextItem } from "./chat";
import { estimateTokens } from "./chat.estimateTokens";
import { MESSAGE_FIELDS as MESSAGE_FIELDS_LOCAL, encodeMessageRow } from "./context";
import { PublicationError, failPublication } from "./errors";
import { SESSION_LINK_FIELDS, encodeSessionLinkRow } from "./session-link";
import { quote } from "./storage";
import { MESSAGES, SESSIONS, SESSION_LINKS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextFreshness } from "./service.contextFreshness";
import { contextScope } from "./service.contextScope";
import { requirePerspectivePeer } from "./service.requirePerspectivePeer";
import { selectConclusions } from "./service.selectConclusions";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * `requestTimeMs` is the conclusion validity-window `as_of` and the reported
 * `assembled_at` (D3b, slice 10). The registry passes real request time on
 * every live call; the `Date.now()` fallback below exists only for in-process
 * harnesses that call with one argument, the same fallback and reason as
 * `service.getRecallEligibility.ts`.
 */
export async function getContext(reader: DatasetAdapter, requestBytes: Uint8Array, requestTimeMs?: number): Promise<ContextResult> {
const request = parseGetContext(requestBytes);
      const asOf = requestTimeMs ?? Date.now();
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
      // D3b: a named perspective must be a real peer of this workspace. It is
      // checked AFTER the requester's own membership, so a refused requester
      // learns nothing about which peer names exist.
      await requirePerspectivePeer(reader, request.workspace_name, request.observer_peer_name, "/observer_peer_name");
      await requirePerspectivePeer(reader, request.workspace_name, request.subject_peer_name, "/subject_peer_name");

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

      // D3b: conclusions go FIRST into the shared wire budget -- they are the
      // distilled view the perspective asked for. Their SCOPE is the message
      // scope: the requested session plus its linked chain (and session-less,
      // workspace-level conclusions). A conclusion from any other session is
      // not part of this context and raises no flag -- it used to be selected
      // from every session the requester belonged to while `effective_sessions`
      // said "main", and a protected one anywhere made every context partial.
      // Inside the scope the read boundary is the requester's CURRENT
      // membership, exactly as for messages: an in-chain conclusion or a
      // source it may not read is withheld with only a coarse flag.
      // Observer/subject never reach either check.
      const chain = new Set<string>([request.session_name, ...linkedSessions]);
      const visibility = new Map<string, boolean>(authorizedSessions.map((name) => [name, true]));
      for (const name of unauthorizedSessions) visibility.set(name, false);
      const canSeeSession = async (sessionName: string): Promise<boolean> => {
        const known = visibility.get(sessionName);
        if (known !== undefined) return known;
        let allowed = true;
        try {
          await requireCurrentMembership(reader, request.workspace_name, sessionName, request.peer_name, "/peer_name");
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== "invalid_reference") throw error;
          allowed = false;
        }
        visibility.set(sessionName, allowed);
        return allowed;
      };
      const selection = await selectConclusions(reader, {
        workspace: request.workspace_name,
        observer: request.observer_peer_name,
        subject: request.subject_peer_name,
        asOf,
        maxItems: request.max_items,
        byteBudget: MAX_CONTEXT_WIRE_BYTES - 2,
        inScope: async (sessionName) => chain.has(sessionName),
        canSeeSession,
      });

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
      let budget = 2 + selection.usedBytes; // brackets, matching the rest of this file's convention.
      let budgetStopped = linksTruncated;
      for (const candidate of candidates) {
        const encoded = encodeMessageRow(candidate.row);
        const publicId = encoded.public_id as string;
        if (items.length >= request.max_items) {
          recordExcluded({ reason: "budget_exceeded", session_name: candidate.sessionName, public_id: publicId });
          budgetStopped = true;
          continue;
        }
        const item = projectContextItem(encoded);
        const wireBytes = contextItemWireBytes(item) + 1;
        if (budget + wireBytes > MAX_CONTEXT_WIRE_BYTES) {
          recordExcluded({ reason: "budget_exceeded", session_name: candidate.sessionName, public_id: publicId });
          budgetStopped = true;
          continue;
        }
        budget += wireBytes;
        items.push(item);
      }

      // #85, overnight ruling R4 (docs/overnight/DECISIONS.md): "full" means
      // COMPLETE -- nothing excluded for any reason, authorization included.
      // D3b: a withheld or budgeted conclusion is an exclusion too.
      const conclusionsComplete = !selection.incomplete && !selection.truncated;
      const complete = excluded.length === 0 && excludedOmitted === 0 && conclusionsComplete;
      return {
        items,
        coverage: complete ? "full" : "partial",
        excluded,
        excluded_omitted: excludedOmitted,
        scope: {
          session_name: request.session_name,
          effective_sessions: authorizedSessions,
          observer_peer_name: request.observer_peer_name,
          subject_peer_name: request.subject_peer_name,
        },
        conclusions: selection.conclusions,
        summary: selection.summary,
        conclusions_coverage: { complete: conclusionsComplete },
        budget: {
          max_items: request.max_items,
          max_wire_bytes: MAX_CONTEXT_WIRE_BYTES,
          used_wire_bytes: budget,
          tokenizer: null,
          token_count_kind: "estimate",
          estimate_heuristic: "ceil(utf8_bytes/4)",
          estimated_tokens: estimateTokens(budget),
          truncated: budgetStopped || excludedOmitted > 0 || selection.truncated,
        },
        freshness: await contextFreshness(reader, asOf),
      };
}
