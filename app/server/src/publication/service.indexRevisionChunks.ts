import { type ChatModelFn } from "./chat";
import { failPublication } from "./errors";
import { CHUNK_STATUSES, SEARCH_CHUNK_FIELDS, chunkText, deriveChunkId, deriveContentHash, encodeSearchChunkRow, parseIndexRevision } from "./search-chunk";
import { quote } from "./storage";
import { RESERVED_TYPE_VOCABULARY, SEARCH_CHUNKS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { findNode } from "./service.findNode";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { parseSnapshotArray } from "./service.parseSnapshotArray";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { sameEncodedValue } from "./service.sameEncodedValue";
import { selectAcceptedRevision } from "./service.selectAcceptedRevision";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export function indexRevisionChunks(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array) {
const request = parseIndexRevision(requestBytes);
      return mutateContextWrite(core, async () => {
        await requireContextWorkspaceRow(writer, request.workspace_name);
        await writer.refresh("nodes");
        const node = await findNode(writer, request.workspace_name, request.node_id);
        if (node === null) failPublication("invalid_reference", "/node_id");

        await writer.refresh("node_revisions");
        const resolved = await selectAcceptedRevision(
          writer,
          request.workspace_name,
          request.node_id,
          request.revision_id,
        );
        if (resolved === null) failPublication("invalid_reference", "/revision_id");
        const selected = resolved.selected;

        // type_term_id and term_ids come from the revision's OWN immutable
        // snapshot, exactly like the association evidence path -- never from
        // a live join against node_revision_terms, which is a derived,
        // rebuildable projection.
        const snapshot = parseSnapshotArray(selected.term_snapshot_json, "");
        let typeTermId: string | null = null;
        let typeAssignments = 0;
        const termIds: string[] = [];
        for (const entry of snapshot) {
          const termId = (entry as Record<string, unknown>).term_id;
          if (typeof termId !== "string") failPublication("integrity_failure", "");
          termIds.push(termId);
          if ((entry as Record<string, unknown>).vocabulary_name_snapshot === RESERVED_TYPE_VOCABULARY) {
            typeAssignments += 1;
            typeTermId = termId;
          }
        }
        // publishRevision requires EXACTLY one reserved-type assignment
        // before a revision is ever accepted, so an accepted revision with
        // zero OR MORE THAN ONE here is stored corruption, not a caller
        // mistake -- 0/1/>1 are each distinguished, matching the standing
        // rule that a duplicate logical identity is never a tie to break by
        // taking the last (or first) match.
        if (typeAssignments !== 1 || typeTermId === null) failPublication("integrity_failure", "");

        const title = selected.title;
        const body = selected.body;
        if (typeof title !== "string" || typeof body !== "string") failPublication("integrity_failure", "");
        const derivedText = `${title}\n\n${body}`;
        const embeddingProfileName = request.embedding_profile.name;
        const pieces = chunkText(derivedText);

        const targets = pieces.map((piece, index) => {
          const chunkIndex = BigInt(index);
          const id = deriveChunkId(
            request.revision_id,
            request.chunker_version,
            embeddingProfileName,
            chunkIndex,
          );
          const physical: Record<string, unknown> = {
            id,
            workspace_name: request.workspace_name,
            node_id: request.node_id,
            revision_id: request.revision_id,
            chunk_index: chunkIndex,
            text: piece,
            content_hash: deriveContentHash(piece),
            chunker_version: request.chunker_version,
            embedding_profile: embeddingProfileName,
            // Off the authoritative write path, always: see the method doc.
            embedding: null,
            type_term_id: typeTermId,
            // STALE-ABLE copies of the snapshot at index time, never a live
            // join and never an authorization substitute: a caller filtering
            // search_chunks_v1 on these columns is filtering a projection
            // that can drift from the revision's current term assignments,
            // not re-deriving access control.
            term_ids: termIds,
            observer_peer_name: (selected.observer_peer_name as string | null) ?? null,
            subject_peer_name: (selected.subject_peer_name as string | null) ?? null,
            session_name: (selected.session_name as string | null) ?? null,
            status: CHUNK_STATUSES[0],
            attempts: 0n,
            last_attempt_at: null,
            embedded_at: null,
            error_code: null,
          };
          return { id, physical };
        });

        await writer.refresh(SEARCH_CHUNKS);
        const scope =
          `${contextScope(request.workspace_name)} AND revision_id = ${quote(request.revision_id)}` +
          ` AND chunker_version = ${quote(request.chunker_version)}` +
          ` AND embedding_profile = ${quote(embeddingProfileName)}`;
        const existing = await writer.query(SEARCH_CHUNKS, scope);
        const existingById = new Map(existing.map((row) => [row.id as string, row]));

        if (targets.length > 0 && targets.every((target) => existingById.has(target.id))) {
          return {
            outcome: "already_satisfied" as const,
            rows: targets.map((target) => encodeSearchChunkRow(existingById.get(target.id)!)),
          };
        }

        const toWrite = targets.filter((target) => !existingById.has(target.id));

        await core.contextBoundary("before_write", false);
        core.markAttemptedWrite();
        if (toWrite.length > 0) {
          try {
            await writer.append(
              SEARCH_CHUNKS,
              toWrite.map((target) => target.physical),
            );
          } catch {
            core.poison();
            failPublication("recovery_required", "");
          }
        }
        await core.contextBoundary("after_write", true);

        const stored = await core.afterWrite(async () => {
          await writer.refresh(SEARCH_CHUNKS);
          const rows: Record<string, unknown>[] = [];
          for (const target of targets) {
            const row = await contextOne(
              writer,
              SEARCH_CHUNKS,
              // SCOPED on the requesting workspace, like every other context
              // read in this file (`contextScope`) -- an id match alone does
              // not prove the row landed in the requesting workspace, and a
              // cross-workspace id collision would otherwise surface as
              // `contextOne`'s own `>1` integrity_failure rather than as the
              // scoping fault it actually is.
              `${contextScope(request.workspace_name)} AND id = ${quote(target.id)}`,
            );
            if (row === null) {
              core.poison();
              failPublication("recovery_required", "");
            }
            const encoded = encodeSearchChunkRow(row);
            // COMPARE every physical field against what was asked for,
            // exactly like the accepted `writeContextRow.bind(null, writer, core)` convention: decoding
            // proves structural validity and says nothing about whether the
            // row holds what was asked for. This is the ONLY write path in
            // the kernel that hand-constructs Arrow buffers, which is
            // precisely the construction that could silently write the
            // wrong value (e.g. an out-of-range bigint landing as a
            // different in-range one).
            const expected = encodeSearchChunkRow(target.physical);
            for (const field of SEARCH_CHUNK_FIELDS) {
              // `embedding` is validated inside `encodeSearchChunkRow` but
              // never appears in its returned wire object -- nothing to
              // compare here beyond the encode call already having succeeded.
              if (field === "embedding") continue;
              if (!sameEncodedValue(encoded[field], expected[field])) {
                core.poison();
                failPublication("recovery_required", "");
              }
            }
            rows.push(encoded);
          }
          return rows;
        });
        await core.contextBoundary("after_readback", true);
        return { outcome: "indexed" as const, rows: stored };
      });
}
