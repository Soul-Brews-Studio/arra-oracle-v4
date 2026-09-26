import { PublicationError, failPublication } from "./errors";
import { microsToTimestamp } from "./rows";
import { SESSION_LINK_FIELDS, encodeSessionLinkRow, parseCreateSessionLink } from "./session-link";
import { quote } from "./storage";
import { assertSessionLinkAcyclic } from "./service.assertSessionLinkAcyclic";
import { SESSION_LINKS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { resolveSessionLinkEndpoints } from "./service.resolveSessionLinkEndpoints";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";
import { writeContextRow } from "./service.writeContextRow";

export function createSessionLink(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null }, requestBytes: Uint8Array) {
// Self-link is decidable from bytes alone, so it is checked by the
      // parser, OUTSIDE the queue: parsing inside the queued turn would make
      // a malformed request an owner event, exactly as appendMessages'
      // static-validation-first discipline requires.
      const request = parseCreateSessionLink(requestBytes);
      return mutateContextWrite(core, async () => {
        await requireContextWorkspaceRow(writer, request.workspace_name);
        // Reference resolution, IN ORDER: /from_session_name then
        // /to_session_name. Existence only -- no active-membership rule.
        await resolveSessionLinkEndpoints(
          writer,
          request.workspace_name,
          request.from_session_name,
          request.to_session_name,
        );

        await writer.refresh(SESSION_LINKS);
        const byId = await contextOne(
          writer,
          SESSION_LINKS,
          `${contextScope(request.workspace_name)} AND id = ${quote(request.id)}`,
        );
        if (byId !== null) {
          const stored = encodeSessionLinkRow(byId);
          const samePayload =
            stored.from_session_name === request.from_session_name &&
            stored.to_session_name === request.to_session_name &&
            stored.relation === request.relation &&
            stored.evidence_ref === request.evidence_ref &&
            stored.created_by_peer_name === request.created_by_peer_name;
          // EXACT replay: retained row, no clock sample, no write. A changed
          // payload under the same id is a RETURNED conflict, never thrown.
          return samePayload
            ? { outcome: "already_satisfied" as const, row: stored }
            : { outcome: "conflict" as const, row: stored };
        }

        // Cycle policy: PRESERVED for the two directed relations. `related_to`
        // participates in neither traversal nor bound.
        await assertSessionLinkAcyclic(
          writer,
          request.workspace_name,
          request.from_session_name,
          request.to_session_name,
          request.relation,
        );

        // ONLY a real creation samples the clock.
        const sampled = options.clock();
        if (typeof sampled !== "number" || !Number.isSafeInteger(sampled)) {
          failPublication("invalid_request", "");
        }
        const micros = BigInt(sampled) * 1000n;
        try {
          // Rendering is the range check: no second copy of the Gregorian
          // grammar, and an unrenderable sample never reaches the store. The
          // clock is operator configuration, not a caller field: invalid
          // clock output is `invalid_request`, not an integrity fault.
          microsToTimestamp(micros);
        } catch (error) {
          if (!(error instanceof PublicationError)) throw error;
          return failPublication("invalid_request", "");
        }

        const physical: Record<string, unknown> = {
          id: request.id,
          workspace_name: request.workspace_name,
          from_session_name: request.from_session_name,
          to_session_name: request.to_session_name,
          relation: request.relation,
          evidence_ref: request.evidence_ref,
          // Decision 2 forbids a membership requirement and decision 6 calls
          // this a stored fact, not identity -- existence of the named peer
          // is DELIBERATELY unverified in v1. A dangling peer name is
          // storable; no lookup is added.
          created_by_peer_name: request.created_by_peer_name,
          // Arrow needs BigInt microseconds; a JS Number silently corrupts.
          created_at: micros,
        };
        const expected = encodeSessionLinkRow(physical);

        const stored = await writeContextRow(writer, core, 
          SESSION_LINKS,
          physical,
          async () => {
            const found = await contextOne(
              writer,
              SESSION_LINKS,
              `${contextScope(request.workspace_name)} AND id = ${quote(request.id)}`,
            );
            if (found === null) {
              core.poison();
              failPublication("recovery_required", "");
            }
            return encodeSessionLinkRow(found);
          },
          expected,
          SESSION_LINK_FIELDS,
          false,
        );
        return { outcome: "created" as const, row: stored };
      });
}
