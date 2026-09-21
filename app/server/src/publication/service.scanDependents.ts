import { MAX_EXAMINED_POSITIONS, MAX_RESULT_WIRE_BYTES as MAX_EVIDENCE_WIRE_BYTES, MAX_SELECTED_REVISIONS, MAX_VISITED_NODES, deriveLinkRows, parseScanDependents } from "./association";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { contextOne } from "./service.contextOne";
import { parseSnapshotArray } from "./service.parseSnapshotArray";
import { requireWorkspace } from "./service.requireWorkspace";
import { selectAcceptedRevision } from "./service.selectAcceptedRevision";
import { type DatasetAdapter } from "./service.types";
import { wireBytesOf } from "./service.wireBytesOf";

export async function scanDependents(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown>> {
const request = parseScanDependents(requestBytes);
      await requireWorkspace(reader, request.workspace_name);

      // Capture the witness AFTER an explicit refresh. The page version and
      // every returned cursor version are this SAME captured value; they are
      // not independently sampled.
      await reader.refresh("nodes");
      const captured = await reader.version("nodes");
      if (!Number.isSafeInteger(captured) || captured <= 0) failPublication("integrity_failure", "");
      const capturedText = BigInt(captured).toString(10);
      if (request.cursor !== null && request.cursor.nodes_version !== capturedText) {
        // A stale witness is a conservative restart, never a reinterpretation
        // of a cursor against changed heads.
        return { outcome: "restart_required" };
      }

      const occurrences: Record<string, unknown>[] = [];
      /** Bytes of the ACTUAL candidate response, cursor and control included. */
      const candidateBytes = (rows: Record<string, unknown>[], cursor: Record<string, unknown> | null) =>
        wireBytesOf({ outcome: "page", nodes_version: capturedText, occurrences: rows, next_cursor: cursor });
      let visitedNodes = 0;
      let selectedRevisions = 0;
      let examinedPositions = 0;
      // Traversal progress. Advances over nonmatching links and completed
      // revisions, so it can grow AFTER the last accepted match.
      let nextCursor: Record<string, unknown> | null = null;
      // The last boundary PROVEN to fit alongside the occurrences accepted up
      // to that point, with the count it was proven against. Kept separately:
      // reusing traversal progress on overflow re-measures the very value that
      // overflowed, which is why the previous fallback could only throw again.
      let lastMeasuredCursor: Record<string, unknown> | null = null;
      let fittedCount = 0;

      const cursorAt = (nodeId: string, revisionNo: string | null, position: string | null) => ({
        workspace_name: request.workspace_name,
        target_kind: request.target_kind,
        target_key: request.target_key,
        revision_mode: request.revision_mode,
        nodes_version: capturedText,
        node_id: nodeId,
        revision_no: revisionNo,
        position,
      });

      /** Has the witness moved since it was captured? */
      const witnessMoved = async (): Promise<boolean> => {
        await reader.refresh("nodes");
        const now = await reader.version("nodes");
        if (!Number.isSafeInteger(now) || now <= 0) failPublication("integrity_failure", "");
        return BigInt(now).toString(10) !== capturedText;
      };

      // At the SAME nodes version the cursor's boundary must be real, even
      // when both ordinal and position are null. Strict-greater enumeration
      // would skip this check, and an inclusive fetch would silently move past
      // a node that does not exist.
      //
      // The fault is COLLECTED rather than thrown: these reads happen after
      // the witness was captured, so a cursor that was valid when it was
      // issued can be invalidated by a concurrent write between the capture
      // and this check. Blaming the caller's cursor for that is wrong -- at a
      // changed witness the answer is restart, and only at an UNCHANGED
      // witness is the cursor itself genuinely unusable.
      if (request.cursor !== null) {
        const cur = request.cursor;
        let cursorFault: string | null = null;
        const node = await contextOne(
          reader,
          "nodes",
          `workspace_name = ${quote(request.workspace_name)} AND id = ${quote(cur.node_id)}`,
        );
        if (node === null) cursorFault = "/cursor/node_id";
        if (cursorFault === null && cur.revision_no !== null) {
          const at = await selectAcceptedRevision(reader, request.workspace_name, cur.node_id, null);
          if (at === null) cursorFault = "/cursor/node_id";
          else {
            const chainAt =
              request.revision_mode === "current"
                ? [at.ancestry.encoded[at.ancestry.encoded.length - 1]!]
                : at.ancestry.encoded;
            const revisionAt = chainAt.find((r) => r.revision_no === cur.revision_no);
            // The ordinal must belong to the SELECTED MODE, not merely exist.
            if (revisionAt === undefined) cursorFault = "/cursor/revision_no";
            else if (cur.position !== null) {
              const links = deriveLinkRows(
                request.workspace_name,
                revisionAt.id as string,
                parseSnapshotArray(revisionAt.link_snapshot_json, ""),
              );
              if (!links.some((l) => l.position === cur.position)) cursorFault = "/cursor/position";
            }
          }
        }
        if (cursorFault !== null) {
          if (await witnessMoved()) return { outcome: "restart_required" };
          failPublication("invalid_request", cursorFault);
        }
      }

      let cursorNode = request.cursor?.node_id ?? null;
      // A node with an UNFINISHED revision is refetched inclusively; a node
      // already fully examined (both null) is passed strictly.
      let inclusive = request.cursor !== null && request.cursor.revision_no !== null;
      let done = false;

      while (!done) {
        if (visitedNodes >= MAX_VISITED_NODES) break;
        const predicate =
          cursorNode === null
            ? `workspace_name = ${quote(request.workspace_name)}`
            : `workspace_name = ${quote(request.workspace_name)} AND id ${inclusive ? ">=" : ">"} ${quote(cursorNode)}`;
        const page = await reader.orderedProjection(
          "nodes",
          predicate,
          ["id"],
          { column: "id", ascending: true },
          1,
        );
        if (page.length === 0) break;
        const nodeId = page[0]!.id;
        if (typeof nodeId !== "string") failPublication("integrity_failure", "");

        // 0/1/>1 discrimination on EVERY selected identity. A duplicate at a
        // page edge is invisible to keyset advancement, so it must be caught
        // by an equality probe rather than by a page-level assertion.
        const same = await reader.query(
          "nodes",
          `workspace_name = ${quote(request.workspace_name)} AND id = ${quote(nodeId)}`,
          2,
        );
        if (same.length !== 1) failPublication("integrity_failure", "");

        visitedNodes += 1;
        cursorNode = nodeId;
        inclusive = false;

        const resolved = await selectAcceptedRevision(reader, request.workspace_name, nodeId, null);
        if (resolved === null) {
          nextCursor = cursorAt(nodeId, null, null);
          continue;
        }
        // current selects the captured head only; history selects all accepted
        // ancestors, oldest first.
        const chain =
          request.revision_mode === "current"
            ? [resolved.ancestry.encoded[resolved.ancestry.encoded.length - 1]!]
            : resolved.ancestry.encoded;

        const resumeRevision =
          request.cursor !== null && request.cursor.node_id === nodeId
            ? request.cursor.revision_no
            : null;
        const resumePosition =
          request.cursor !== null && request.cursor.node_id === nodeId
            ? request.cursor.position
            : null;

        for (const revision of chain) {
          const revisionNo = revision.revision_no as string;
          if (resumeRevision !== null) {
            const ordinal = BigInt(revisionNo);
            const boundary = BigInt(resumeRevision);
            // position null means that ordinal was FULLY examined, so it is
            // skipped entirely rather than replayed from its first link.
            if (resumePosition === null ? ordinal <= boundary : ordinal < boundary) continue;
          }
          if (selectedRevisions >= MAX_SELECTED_REVISIONS) {
            done = true;
            break;
          }
          selectedRevisions += 1;

          const links = deriveLinkRows(
            request.workspace_name,
            revisionNo === undefined ? "" : (revision.id as string),
            parseSnapshotArray(revision.link_snapshot_json, ""),
          );
          for (const link of links) {
            const position = link.position as string;
            if (
              resumeRevision !== null &&
              revisionNo === resumeRevision &&
              resumePosition !== null &&
              BigInt(position) <= BigInt(resumePosition)
            ) {
              continue;
            }
            if (examinedPositions >= MAX_EXAMINED_POSITIONS) {
              done = true;
              break;
            }
            examinedPositions += 1;
            if (link.target_key !== request.target_key) {
              nextCursor = cursorAt(nodeId, revisionNo, position);
              continue;
            }
            const occurrence = {
              workspace_name: request.workspace_name,
              node_id: nodeId,
              revision_id: revision.id as string,
              revision_no: revisionNo,
              content_digest: revision.content_digest as string,
              snapshot_head_revision_id: resolved.head,
              is_snapshot_head: revision.id === resolved.head,
              link,
            };
            const candidateCursor = cursorAt(nodeId, revisionNo, position);
            // Acceptance is measured against the TERMINAL form -- the smallest
            // response that can carry this match, because an exhausted page
            // emits a null cursor. Charging a continuation cursor that may
            // never be emitted would split a legal exact-cap final page.
            // Equality is allowed.
            if (candidateBytes([...occurrences, occurrence], null) > MAX_EVIDENCE_WIRE_BYTES) {
              // Never advance over the omitted matching occurrence. With no
              // accepted prefix, a single unrepresentable item fails rather
              // than spinning on an unchanged cursor.
              if (occurrences.length === 0) failPublication("limit_exceeded", "");
              done = true;
              break;
            }
            occurrences.push(occurrence);
            nextCursor = candidateCursor;
            // Separately: the longest prefix whose CONTINUATION form also
            // fits. A terminal page never needs this; a continued one can
            // return no more than this much.
            if (candidateBytes(occurrences, candidateCursor) <= MAX_EVIDENCE_WIRE_BYTES) {
              lastMeasuredCursor = candidateCursor;
              fittedCount = occurrences.length;
            }
            if (occurrences.length >= request.limit) {
              done = true;
              break;
            }
          }
          if (done) break;
          nextCursor = cursorAt(nodeId, revisionNo, null);
        }
        if (!done) nextCursor = cursorAt(nodeId, null, null);
      }

      // Check the witness AGAIN after all reads and before returning. Same
      // validation as the initial capture: an out-of-range SDK value must not
      // reach BigInt and become raw or rounded output.
      if (await witnessMoved()) return { outcome: "restart_required" };

      // Exhausted only when enumeration ran out, not when a budget stopped it.
      const exhausted = !done && visitedNodes < MAX_VISITED_NODES;
      const emitted = exhausted ? null : nextCursor;
      const result = {
        outcome: "page" as const,
        nodes_version: capturedText,
        occurrences,
        next_cursor: emitted,
      };
      // An EXHAUSTED page always fits: every occurrence was accepted against
      // exactly this terminal form. A CONTINUED one can still exceed, because
      // the emitted boundary can be later and larger than the last measured
      // candidate. Then the page is not thrown away -- it is trimmed to the
      // prefix whose own continuation cursor was proven to fit.
      if (wireBytesOf(result) > MAX_EVIDENCE_WIRE_BYTES) {
        if (fittedCount === 0 || lastMeasuredCursor === null) {
          failPublication("limit_exceeded", "");
        }
        // Fall back to the CHECKPOINT, not to traversal progress. Control
        // fields can grow past the last accepted match -- a run of nonmatching
        // links, or a completed revision -- and that growth is exactly what
        // pushed the response over. The cursor is the one belonging to the
        // LAST occurrence still returned, so the next page neither repeats a
        // returned occurrence nor steps over an omitted match.
        const fitted = {
          outcome: "page" as const,
          nodes_version: capturedText,
          occurrences: occurrences.slice(0, fittedCount),
          next_cursor: lastMeasuredCursor,
        };
        if (wireBytesOf(fitted) > MAX_EVIDENCE_WIRE_BYTES) failPublication("limit_exceeded", "");
        return fitted;
      }
      return result;
}
