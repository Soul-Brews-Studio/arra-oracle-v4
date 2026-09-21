import { type JcsObject, type JcsValue } from "../contracts/jcs";
import { type RevisionResult, revisionOp } from "../contracts/revision-v1";
import { failPublication, isContractError } from "./errors";
import { MAX_CHAIN_ROWS, MAX_CHAIN_WIRE_BYTES, encodeNodeRow, encodeRevisionRow, parseInt64Text, revisionWireBytes, timestampToMicros } from "./rows";
import { quote } from "./storage";
import { buildRevisionRow } from "./service.buildRevisionRow";
import { closedKeys } from "./service.closedKeys";
import { SUPERSEDE_LOG } from "./service.constants";
import { decodeVerifiedRevision } from "./service.decodeVerifiedRevision";
import { encodeEnvelopeForChecks } from "./service.encodeEnvelopeForChecks";
import { findNode } from "./service.findNode";
import { findOperation } from "./service.findOperation";
import { findRevisionById } from "./service.findRevisionById";
import { parseRequest } from "./service.parseRequest";
import { requireNodeId } from "./service.requireNodeId";
import { requireOperationId } from "./service.requireOperationId";
import { requireWorkspaceName } from "./service.requireWorkspaceName";
import { type BuiltRevision, type Clock, type DatasetAdapter, type IdSource, type OwnerCore, type PublishOutcome } from "./service.types";
import { validateNewContent } from "./service.validateNewContent";
import { walkAncestry } from "./service.walkAncestry";
import { writableTimestamp } from "./service.writableTimestamp";

export function publishRevision(writer: DatasetAdapter, options: { clock: Clock; newRevisionId: IdSource }, core: OwnerCore, requestBytes: Uint8Array) {
const { afterWrite, boundary, markAttemptedWrite, poison, serial } = core;

const publish = async (requestBytes: Uint8Array): Promise<PublishOutcome> =>
  {
    const outer = parseRequest(requestBytes);
    closedKeys(outer, ["operation_id", "content"], "");
    const operationId = requireOperationId(outer.get("operation_id"), "/operation_id");
    const content = outer.get("content") as JcsValue;

    // The governed codec owns envelope validation and the canonical bytes.
    // Its failures keep the arra-error/v1 envelope untouched.
    let validated: RevisionResult;
    try {
      validated = revisionOp(content, ["content"]);
    } catch (error) {
      if (isContractError(error)) throw error;
      return failPublication("invalid_request", "/content");
    }

    // `RevisionColumns` carries only the five NORMALIZED JSON columns, so the
    // remaining envelope fields are read from the content map that revisionOp
    // has already validated -- not re-derived and not re-validated loosely.
    if (!(content instanceof Map)) failPublication("invalid_request", "/content");
    const envelope = content as JcsObject;
    const workspace = requireWorkspaceName(envelope.get("workspace_name"), "/content/workspace_name");
    const nodeId = requireNodeId(envelope.get("node_id"), "/content/node_id");
    const rawBase = envelope.get("base_revision_id");
    const baseRevisionId = rawBase === null || rawBase === undefined ? null : requireNodeId(rawBase, "/content/base_revision_id");

    await writer.refresh("node_revisions");
    const existingOperation = await findOperation(writer, workspace, operationId);

    if (existingOperation !== null) {
      // Operation lookup OUTRANKS a stale current base on an accepted retry.
      const encoded = encodeRevisionRow(existingOperation);
      if (encoded.content_digest !== validated.content_digest) {
        // A changed payload under the same key is a classification, not
        // invalid bytes.
        return { outcome: "conflict", reason: "operation_digest" };
      }
      if (encoded.node_id !== nodeId) failPublication("integrity_failure");

      await writer.refresh("nodes");
      const node = await findNode(writer, workspace, nodeId);
      if (node !== null) {
        const encodedNode = encodeNodeRow(node);
        const headId = encodedNode.current_revision_id;
        if (typeof headId !== "string") failPublication("integrity_failure");
        const ancestry = await walkAncestry(writer, workspace, nodeId, headId);
        const reachable = ancestry.encoded.some((row) => row.id === encoded.id);
        if (reachable) {
          // The ORIGINAL values, even if a later head now exists.
          return {
            outcome: "idempotent",
            node_id: nodeId,
            revision_id: encoded.id as string,
            revision_no: encoded.revision_no as string,
            content_digest: encoded.content_digest as string,
            node_created_at: encodedNode.created_at as string,
            revision_created_at: encoded.created_at as string,
          };
        }
      }
      // Same digest but unpublished: an orphan awaiting resumption. Resuming
      // reuses the STORED id/ordinal/timestamp; it never allocates a new row.
      return await resumeOrphan(encoded, workspace, nodeId, baseRevisionId);
    }

    return await publishFresh(validated, envelope, workspace, nodeId, baseRevisionId, operationId);
  };

const resumeOrphan = async (encoded: Record<string, unknown>, workspace: string, nodeId: string, _baseRevisionId: string | null): Promise<PublishOutcome> =>
  {
    // A resuming orphan is still NEW publication for reference purposes:
    // re-validate against present policy before it becomes visible.
    await validateNewContent(writer, workspace, nodeId, encoded);

    await writer.refresh("nodes");
    const node = await findNode(writer, workspace, nodeId);
    const storedBase = encoded.base_revision_id;

    // #29 lifecycle refusal, same probe as publishFresh's. A resuming orphan
    // is still NEW publication for reference purposes (see the docstring
    // above), and retirement IS present policy: a node that already carries
    // a terminal event refuses resumption too, not only a fresh append. This
    // never touches the exact-replay guarantee -- resumeOrphan is reached
    // only for a revision NOT reachable from the head, i.e. one that was
    // never successfully published; a publish that succeeded before
    // retirement returns idempotent earlier in `publish` and never reaches
    // here.
    await writer.refresh(SUPERSEDE_LOG);
    const terminalEvents = await writer.query(
      SUPERSEDE_LOG,
      `workspace_name = ${quote(workspace)} AND old_id = ${quote(nodeId)}`,
      2,
    );
    if (terminalEvents.length > 1) failPublication("integrity_failure");
    if (terminalEvents.length === 1) return { outcome: "conflict", reason: "node_retired" };

    if (node === null) {
      if (storedBase !== null) failPublication("integrity_failure");
      // Resume ONLY if no OTHER revision claims this node id.
      //
      // The previous version checked the stored base and nothing else, so a
      // rival operation's orphan on the same absent node was simply adopted
      // -- the resuming operation took over a disputed identity. Uniqueness
      // of the scoped claim is what decides this; we do not pick a winner.
      await writer.refresh("node_revisions");
      const claims = await writer.query(
        "node_revisions",
        `workspace_name = ${quote(workspace)} AND node_id = ${quote(nodeId)}`,
      );
      const rivals = claims.filter((row) => row.id !== encoded.id);
      if (rivals.length > 0) {
        // Leave the orphan hidden rather than publishing over a contender.
        return { outcome: "conflict", reason: "node_id" };
      }
      return await headNodeAtRevision(encoded, workspace, nodeId);
    }
    const encodedNode = encodeNodeRow(node);
    const headId = encodedNode.current_revision_id;
    if (typeof headId !== "string") failPublication("integrity_failure");
    // An existing-node orphan resumes only when the head still equals its base.
    if (headId !== storedBase) return { outcome: "conflict", reason: "stale_base" };
    return await advanceHead(encoded, workspace, nodeId, headId, encodedNode);
  };

const publishFresh = async (validated: RevisionResult, envelope: JcsObject, workspace: string, nodeId: string, baseRevisionId: string | null, operationId: string): Promise<PublishOutcome> =>
  {
    await writer.refresh("nodes");
    const node = await findNode(writer, workspace, nodeId);

    if (baseRevisionId === null) {
      if (node !== null) {
        // A node with a NULL head has unknown provenance: this slice creates
        // none, so something else allocated it and we cannot tell what. That
        // is integrity_failure, NOT a node_id conflict -- reporting a
        // conflict would imply a legitimate rival claim and invite a retry
        // against state nobody can account for. Checked BEFORE classifying.
        if (encodeNodeRow(node).current_revision_id === null) {
          failPublication("integrity_failure");
        }
        return { outcome: "conflict", reason: "node_id" };
      }
      // Another operation's orphan may already claim this node ID.
      const claims = await writer.query(
        "node_revisions",
        `workspace_name = ${quote(workspace)} AND node_id = ${quote(nodeId)}`,
      );
      if (claims.length > 0) return { outcome: "conflict", reason: "node_id" };
      await validateNewContent(writer, workspace, nodeId, encodeEnvelopeForChecks(validated, envelope));
      return await createFirstRevision(validated, envelope, workspace, nodeId, operationId);
    }

    // State error, not a request-pointer error: section 8 puts read/state
    // failures at path "". A missing REFERENCED peer or session still points
    // at its content field; an absent node does not.
    if (node === null) failPublication("not_found", "");
    const encodedNode = encodeNodeRow(node);
    // Same unknown-provenance rule on the append path.
    if (encodedNode.current_revision_id === null) failPublication("integrity_failure");
    const headId = encodedNode.current_revision_id;
    if (typeof headId !== "string") failPublication("integrity_failure");
    if (headId !== baseRevisionId) return { outcome: "conflict", reason: "stale_base" };

    // #29 lifecycle refusal. Reached ONLY when `publish` found no existing
    // operation for this key -- a genuinely NEW revision, never a replay --
    // so an already-accepted retry of a publish that predates retirement
    // still returns idempotent above and never reaches this check.
    await writer.refresh(SUPERSEDE_LOG);
    const terminalEvents = await writer.query(
      SUPERSEDE_LOG,
      `workspace_name = ${quote(workspace)} AND old_id = ${quote(nodeId)}`,
      2,
    );
    if (terminalEvents.length > 1) failPublication("integrity_failure");
    if (terminalEvents.length === 1) return { outcome: "conflict", reason: "node_retired" };

    await validateNewContent(writer, workspace, nodeId, encodeEnvelopeForChecks(validated, envelope));
    return await appendRevision(validated, envelope, workspace, nodeId, headId, encodedNode, operationId);
  };

const createFirstRevision = async (validated: RevisionResult, envelope: JcsObject, workspace: string, nodeId: string, operationId: string): Promise<PublishOutcome> =>
  {
    const createdAtMs = options.clock();
    const createdAt = new Date(createdAtMs).toISOString();
    const revisionId = options.newRevisionId();
    const built = buildRevisionRow(validated, envelope, {
      revisionId,
      workspace,
      nodeId,
      operationId,
      revisionNo: 1n,
      baseRevisionId: null,
      createdAt,
    });
    await appendAndVerify(built, workspace, revisionId, operationId);

    // Recheck absence under the SAME writer ownership before heading a node.
    await writer.refresh("nodes");
    if ((await findNode(writer, workspace, nodeId)) !== null) {
      return { outcome: "conflict", reason: "node_id" };
    }
    const nodeRow = {
      id: nodeId,
      workspace_name: workspace,
      current_revision_id: revisionId,
      // Node timestamps come from the stored revision, not a second sample.
      created_at: BigInt(createdAtMs) * 1000n,
      updated_at: BigInt(createdAtMs) * 1000n,
    };
    markAttemptedWrite();
    await afterWrite(async () => {
      await writer.append("nodes", [nodeRow]);
    });
    await boundary("after_head_publication", true);
    await verifyFinalState(workspace, nodeId, revisionId);
    return {
      outcome: "accepted",
      node_id: nodeId,
      revision_id: revisionId,
      revision_no: "1",
      content_digest: validated.content_digest,
      node_created_at: createdAt,
      revision_created_at: createdAt,
    };
  };

const appendRevision = async (validated: RevisionResult, envelope: JcsObject, workspace: string, nodeId: string, headId: string, encodedNode: Record<string, unknown>, operationId: string): Promise<PublishOutcome> =>
  {
    const ancestry = await walkAncestry(writer, workspace, nodeId, headId);
    const headEncoded = ancestry.encoded.at(-1);
    if (headEncoded === undefined) failPublication("integrity_failure");
    const nextOrdinal = parseInt64Text(headEncoded.revision_no) + 1n;

    const createdAtMs = options.clock();
    const createdAt = new Date(createdAtMs).toISOString();
    const revisionId = options.newRevisionId();
    const built = buildRevisionRow(validated, envelope, {
      revisionId,
      workspace,
      nodeId,
      operationId,
      revisionNo: nextOrdinal,
      baseRevisionId: headId,
      createdAt,
    });

    // Budget the prospective row against the existing chain before appending.
    const prospective = ancestry.wireBytes + revisionWireBytes(built.wire) + 1;
    if (prospective > MAX_CHAIN_WIRE_BYTES) failPublication("limit_exceeded");
    if (ancestry.rows.length + 1 > MAX_CHAIN_ROWS) failPublication("limit_exceeded");

    await appendAndVerify(built, workspace, revisionId, operationId);
    return await advanceHeadTo(
      workspace,
      nodeId,
      headId,
      revisionId,
      createdAtMs,
      validated.content_digest,
      nextOrdinal.toString(10),
      encodedNode.created_at as string,
      createdAt,
    );
  };

const headNodeAtRevision = async (encoded: Record<string, unknown>, workspace: string, nodeId: string): Promise<PublishOutcome> =>
  {
    const createdAt = encoded.created_at as string;
    const nodeRow = {
      id: nodeId,
      workspace_name: workspace,
      current_revision_id: encoded.id as string,
      created_at: writableTimestamp(createdAt),
      updated_at: writableTimestamp(createdAt),
    };
    markAttemptedWrite();
    await afterWrite(async () => {
      await writer.append("nodes", [nodeRow]);
    });
    await boundary("after_head_publication", true);
    await verifyFinalState(workspace, nodeId, encoded.id as string);
    return {
      outcome: "accepted",
      node_id: nodeId,
      revision_id: encoded.id as string,
      revision_no: encoded.revision_no as string,
      content_digest: encoded.content_digest as string,
      node_created_at: createdAt,
      revision_created_at: createdAt,
    };
  };

const advanceHead = async (encoded: Record<string, unknown>, workspace: string, nodeId: string, headId: string, encodedNode: Record<string, unknown>): Promise<PublishOutcome> =>
  {
  return advanceHeadTo(
      workspace,
      nodeId,
      headId,
      encoded.id as string,
      Number(timestampToMicros(encoded.created_at as string) / 1000n),
      encoded.content_digest as string,
      encoded.revision_no as string,
      encodedNode.created_at as string,
      encoded.created_at as string,
    );
};

const advanceHeadTo = async (workspace: string, nodeId: string, expectedHeadId: string, newHeadId: string, updatedAtMs: number, digest: string, revisionNo: string, nodeCreatedAt: string, revisionCreatedAt: string): Promise<PublishOutcome> =>
  {
    // The head update is persistence: refresh and update are both inside the
    // attempted-write window, so a thrown SDK rejection here poisons.
    markAttemptedWrite();
    const { rowsUpdated } = await afterWrite(async () => {
      await writer.refresh("nodes");
      return writer.updateWhere(
      "nodes",
      `workspace_name = ${quote(workspace)} AND id = ${quote(nodeId)} AND current_revision_id = ${quote(expectedHeadId)}`,
      {
        current_revision_id: quote(newHeadId),
        // Microseconds as an exact integer literal cast to the column's own
        // timestamp[us] type. `updatedAtMs * 1000` in JS floating point could
        // lose exactness at the top of the range, so the multiply is BigInt.
        updated_at: `CAST(${(BigInt(updatedAtMs) * 1000n).toString(10)} AS TIMESTAMP(6))`,
      },
      );
    });
    // Anything but exactly one row is ambiguous: fail-stop, never guess.
    if (rowsUpdated !== 1) {
      poison();
      failPublication("recovery_required");
    }
    await boundary("after_head_publication", true);
    await verifyFinalState(workspace, nodeId, newHeadId);
    return {
      outcome: "accepted",
      node_id: nodeId,
      revision_id: newHeadId,
      revision_no: revisionNo,
      content_digest: digest,
      node_created_at: nodeCreatedAt,
      revision_created_at: revisionCreatedAt,
    };
  };

const appendAndVerify = async (built: BuiltRevision, workspace: string, revisionId: string, operationId: string): Promise<void> =>
  {
    await boundary("before_append", false);
    markAttemptedWrite();
    try {
      await writer.append("node_revisions", [built.physical]);
    } catch {
      poison();
      failPublication("recovery_required");
    }
    await boundary("after_revision_append", true);
    // From here on the row is durable: any failure is ambiguous.
    await afterWrite(async () => {
      await writer.refresh("node_revisions");
    });
    const byId = await afterWrite(() => findRevisionById(writer, workspace, revisionId));
    const byOperation = await afterWrite(() => findOperation(writer, workspace, operationId));
    if (byId === null || byOperation === null) {
      poison();
      failPublication("recovery_required");
    }
    // Compare the COMPLETE expected immutable row, field by field, not just
    // two digest strings: a digest match proves the content bytes agree, and
    // says nothing about the allocation state written alongside them.
    // A digest recompute failure here means the durable row does not match
    // what we believe we wrote: ambiguous, so it poisons rather than merely
    // reporting integrity_failure and leaving the owner usable.
    const storedById = await afterWrite(async () => decodeVerifiedRevision(byId));
    const storedByOperation = await afterWrite(async () => decodeVerifiedRevision(byOperation));
    const expected = built.wire;
    for (const field of Object.keys(expected)) {
      if (storedById[field] !== expected[field] || storedByOperation[field] !== expected[field]) {
        poison();
        failPublication("recovery_required");
      }
    }
    await boundary("after_revision_readback", true);
  };

const verifyFinalState = async (workspace: string, nodeId: string, expectedHead: string) =>
  {
    // Every step here runs after a durable write, so the whole body is
    // wrapped: a walkAncestry throw used to escape without poisoning.
    await afterWrite(async () => {
      await writer.refresh("nodes");
      const node = await findNode(writer, workspace, nodeId);
      if (node === null) failPublication("recovery_required");
      const encodedNode = encodeNodeRow(node);
      if (encodedNode.current_revision_id !== expectedHead) failPublication("recovery_required");
      await writer.refresh("node_revisions");
      await walkAncestry(writer, workspace, nodeId, expectedHead);
    });
  };

return serial(() => publish(requestBytes));
}
