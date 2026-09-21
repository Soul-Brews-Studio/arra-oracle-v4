import { LINK_FIELDS as LINK_FIELDS_LOCAL, TERM_FIELDS as TERM_FIELDS_LOCAL, parseReconcileRevisionAssociations } from "./association";
import { PublicationError, failPublication } from "./errors";
import { quote } from "./storage";
import { LINKS_TABLE, TERMS_TABLE, WORKSPACES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { encodeDerivedLink } from "./service.encodeDerivedLink";
import { encodeDerivedTerm } from "./service.encodeDerivedTerm";
import { expectedSets } from "./service.expectedSets";
import { findNode } from "./service.findNode";
import { physicalDerivedRow } from "./service.physicalDerivedRow";
import { selectAcceptedRevision } from "./service.selectAcceptedRevision";
import { type DatasetAdapter, type OwnerCore, type SetAction, type TableName } from "./service.types";

export function reconcileRevisionAssociations(writer: DatasetAdapter, core: OwnerCore, requestBytes: Uint8Array) {
const rowsEqual = (a: Record<string, unknown>, b: Record<string, unknown>, fields: readonly string[]) => {
  return fields.every((f) => a[f] === b[f]);
}

const scopeOfRevision = (workspace: string, revisionId: string) => {
  return `workspace_name = ${quote(workspace)} AND revision_id = ${quote(revisionId)}`;
}

const preflight = async (table: TableName, workspace: string, revisionId: string, expected: Record<string, unknown>[], fields: readonly string[], encode: (row: Record<string, unknown>) => Record<string, unknown>) => {
    await writer.refresh(table);
    const raw = await writer.query(table, scopeOfRevision(workspace, revisionId), expected.length + 1);
    // A DERIVED row that cannot be decoded -- a sub-millisecond or
    // out-of-wire-range capture time is physically valid in the timestamp[us]
    // column -- is divergence of a rebuildable projection, NOT authoritative
    // corruption. It is rebuilt here. Only an integrity failure raised BY this
    // decoding is absorbed; anything else is a real fault and rethrows, and
    // the post-write verification decode stays strict and fail-stop.
    let decodable = true;
    let currentRows: Record<string, unknown>[] = [];
    try {
      currentRows = raw.map(encode);
    } catch (error) {
      if (!(error instanceof PublicationError) || error.code !== "integrity_failure") throw error;
      decodable = false;
      currentRows = [];
    }
    const matches = (row: Record<string, unknown>) =>
      currentRows.some((stored) => rowsEqual(stored, row, fields));
    const noDuplicates = currentRows.every(
      (stored, index) =>
        currentRows.findIndex((other) => rowsEqual(other, stored, fields)) === index,
    );
    // An EMPTY set is vacuously a subset, which is what a first
    // materialization looks like; treating it as a rebuild would fire a delete
    // triple for a table with nothing to delete.
    const isSubset =
      noDuplicates && currentRows.every((stored) => expected.some((row) => rowsEqual(stored, row, fields)));
    const allPresent = expected.every(matches);
    const action: SetAction = !decodable
      ? "rebuilt"
      : allPresent && isSubset && currentRows.length === expected.length
        ? "unchanged"
        : isSubset
          ? "filled"
          : "rebuilt";
    return {
      action,
      currentRows,
      // The RAW observed count, so the delete comparison still holds when the
      // stored rows were undecodable and `currentRows` is therefore empty.
      observedCount: raw.length,
      lookaheadReached: raw.length > expected.length,
      toAppend: action === "rebuilt" ? expected : expected.filter((row) => !matches(row)),
    };
  }

const applyTable = async (table: TableName, workspace: string, revisionId: string, plan: Awaited<ReturnType<typeof preflight>>, expected: Record<string, unknown>[], fields: readonly string[], encode: (row: Record<string, unknown>) => Record<string, unknown>, successBoundary: "after_term_write" | "after_link_write", attemptedAny: () => boolean, markAttempted: () => void): Promise<void> => {
    const scope = scopeOfRevision(workspace, revisionId);
    if (plan.action === "unchanged") return;

    // Wire -> physical conversion happens BEFORE the first mutation boundary
    // and before any attempt flag. A conversion fault is a pure programming
    // error, and raising it after `markAttempted` would poison an owner that
    // never reached the SDK.
    const physicalRows = plan.toAppend.map(physicalDerivedRow);

    if (plan.action === "rebuilt") {
      await core.evidenceBoundary("before_delete", attemptedAny());
      markAttempted();
      core.markAttemptedWrite();
      const deleted = await core.afterWrite(async () =>
        writer.deleteDerivedScope(table, workspace, revisionId),
      );
      await core.evidenceBoundary("after_delete", true);
      await core.afterWrite(async () => {
        await writer.refresh(table);
        const left = await writer.query(table, scope, 1);
        // A refreshed EMPTY scoped set is required before reinsertion. A table
        // version is not a row-count substitute: a zero-match delete advances
        // the version while deleting nothing.
        if (left.length !== 0) {
          core.poison();
          failPublication("recovery_required", "");
        }
        // Exact compare when the pre-read exhausted the scope; lower-bound
        // compare when the expected+1 lookahead was reached.
        if (plan.lookaheadReached) {
          if (deleted.numDeletedRows < plan.observedCount) {
            core.poison();
            failPublication("recovery_required", "");
          }
        } else if (deleted.numDeletedRows !== plan.observedCount) {
          core.poison();
          failPublication("recovery_required", "");
        }
      });
      await core.evidenceBoundary("after_delete_readback", true);
    }

    for (const [index, row] of plan.toAppend.entries()) {
      await core.evidenceBoundary("before_write", attemptedAny());
      markAttempted();
      core.markAttemptedWrite();
      // Actual safe errors keep their class through the shared boundary; only
      // genuinely unknown failures normalize. A local catch-all would relabel
      // a deliberately raised error as recovery_required.
      await core.afterWrite(async () => {
        await writer.append(table, [physicalRows[index]!]);
      });
      await core.evidenceBoundary(successBoundary, true);
      await core.afterWrite(async () => {
        await writer.refresh(table);
        const found = await writer.query(table, `${scope} AND position = ${row.position as string}`, 2);
        if (found.length !== 1) {
          core.poison();
          failPublication("recovery_required", "");
        }
        if (!rowsEqual(encode(found[0]!), row, fields)) {
          core.poison();
          failPublication("recovery_required", "");
        }
      });
      await core.evidenceBoundary("after_readback", true);
    }
  }

// STATIC validation precedes owner work. Parsing inside the queued turn
      // would make a malformed request an owner event.
      const request = parseReconcileRevisionAssociations(requestBytes);
      return core.serial(async () => {
        await writer.refresh(WORKSPACES);
        const ws = await contextOne(writer, WORKSPACES, `name = ${quote(request.workspace_name)}`);
        if (ws === null) failPublication("invalid_reference", "/workspace_name");

        // A missing NODE and an orphan revision are different references and
        // must not collapse to one pointer. The reader keeps returning null
        // for an absent node; only this WRITER reports it, at /node_id.
        await writer.refresh("nodes");
        if ((await findNode(writer, request.workspace_name, request.node_id)) === null) {
          failPublication("invalid_reference", "/node_id");
        }

        const resolved = await selectAcceptedRevision(
          writer,
          request.workspace_name,
          request.node_id,
          request.revision_id,
        );
        // An orphan is never materialized into apparent acceptance.
        if (resolved === null) failPublication("invalid_reference", "/revision_id");

        const expected = expectedSets(request.workspace_name, resolved.selected);

        // BOTH scoped sets are preflighted before ANY persistence.
        const termPlan = await preflight(
          TERMS_TABLE, request.workspace_name, request.revision_id,
          expected.terms, TERM_FIELDS_LOCAL, encodeDerivedTerm,
        );
        const linkPlan = await preflight(
          LINKS_TABLE, request.workspace_name, request.revision_id,
          expected.links, LINK_FIELDS_LOCAL, encodeDerivedLink,
        );

        let attempted = false;
        const attemptedAny = () => attempted;
        const markAttempted = () => {
          attempted = true;
        };

        // ALL term-table boundaries finish before ANY link-table boundary.
        await applyTable(
          TERMS_TABLE, request.workspace_name, request.revision_id, termPlan,
          expected.terms, TERM_FIELDS_LOCAL, encodeDerivedTerm,
          "after_term_write", attemptedAny, markAttempted,
        );
        await applyTable(
          LINKS_TABLE, request.workspace_name, request.revision_id, linkPlan,
          expected.links, LINK_FIELDS_LOCAL, encodeDerivedLink,
          "after_link_write", attemptedAny, markAttempted,
        );

        // Final all-set verification: no boundaries, and no ACK for a
        // count-only match.
        if (attempted) {
          await core.afterWrite(async () => {
            for (const [table, rows, fields, encode] of [
              [TERMS_TABLE, expected.terms, TERM_FIELDS_LOCAL, encodeDerivedTerm],
              [LINKS_TABLE, expected.links, LINK_FIELDS_LOCAL, encodeDerivedLink],
            ] as const) {
              await writer.refresh(table);
              const stored = (
                await writer.query(
                  table,
                  scopeOfRevision(request.workspace_name, request.revision_id),
                  rows.length + 1,
                )
              ).map(encode);
              if (stored.length !== rows.length) {
                core.poison();
                failPublication("recovery_required", "");
              }
              for (const row of rows) {
                if (!stored.some((s) => fields.every((f) => s[f] === row[f]))) {
                  core.poison();
                  failPublication("recovery_required", "");
                }
              }
            }
          });
        }

        return {
          outcome:
            termPlan.action === "unchanged" && linkPlan.action === "unchanged"
              ? ("already_satisfied" as const)
              : ("reconciled" as const),
          workspace_name: request.workspace_name,
          node_id: request.node_id,
          revision_id: request.revision_id,
          content_digest: resolved.selected.content_digest as string,
          terms: { action: termPlan.action, count: BigInt(expected.terms.length).toString(10) },
          links: { action: linkPlan.action, count: BigInt(expected.links.length).toString(10) },
        };
      });
}
