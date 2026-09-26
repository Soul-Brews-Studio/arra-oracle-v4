import { type ChatModelFn } from "./chat";
import { failPublication } from "./errors";
import { parseSupersedeNode } from "./lifecycle";
import { encodeNodeRow, encodeRevisionRow } from "./rows";
import { quote } from "./storage";
import { classifyLifecycleReplay } from "./service.classifyLifecycleReplay";
import { NODES, NODE_REVISIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { terminalEventsFor } from "./service.evaluateEligibility";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { type Clock, type DatasetAdapter, type LifecycleEventInput, type LifecycleWriteOutcome, type OwnerCore } from "./service.types";
import { walkForwardChain } from "./service.walkForwardChain";
import { writeContextRow } from "./service.writeContextRow";
import { writeLifecycleEventFresh } from "./service.writeLifecycleEventFresh";

export function supersedeNode(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array): Promise<LifecycleWriteOutcome> {
const request = parseSupersedeNode(requestBytes);
      if (request.new_node_id === request.node_id) {
        failPublication("invalid_request", "/new_node_id");
      }
      return mutateContextWrite(core, async () => {
        // `new_title` plays no part in the replay comparison, so the empty
        // placeholder here is never observed: it is overwritten with the
        // real value below on the genuinely-fresh path only.
        const baseInput: LifecycleEventInput = {
          workspace_name: request.workspace_name,
          node_id: request.node_id,
          expected_revision_id: request.expected_revision_id,
          reason: request.reason,
          peer_name: request.peer_name,
          operation_id: request.operation_id,
          successor: { new_id: request.new_node_id, new_revision_id: request.new_revision_id, new_title: "" },
        };
        // Classification FIRST, before ANY successor state is read. An exact
        // replay must return the retained event with no clock sample and no
        // write even if the successor has since gained a new revision, its
        // forward chain has grown past the bound, or a stored cycle exists
        // somewhere else in the dataset -- none of that may turn an
        // idempotent replay into a thrown fault.
        const classified = await classifyLifecycleReplay(writer, requireContextWorkspaceRow.bind(null, writer), baseInput);
        if (classified.replay) return classified.outcome;

        const chain = await walkForwardChain(writer, request.workspace_name, request.new_node_id);
        if (chain.has(request.node_id)) failPublication("invalid_request", "/new_node_id");

        await writer.refresh(NODES);
        const successorNode = await contextOne(
          writer,
          NODES,
          `${contextScope(request.workspace_name)} AND id = ${quote(request.new_node_id)}`,
        );
        if (successorNode === null) failPublication("invalid_reference", "/new_node_id");
        const encodedSuccessorNode = encodeNodeRow(successorNode);
        if (encodedSuccessorNode.current_revision_id !== request.new_revision_id) {
          failPublication("invalid_reference", "/new_revision_id");
        }

        // #29 slice B (overnight R7): superseding INTO a successor that
        // already carries its own terminal event (retired, or itself already
        // superseded) is refused. A returned conflict, like every other
        // lifecycle-state classification in this file -- the reference
        // itself resolved fine; its STATE is what is refused. Checked once
        // the successor reference has resolved, before the (unaffected)
        // revision lookup below, and after classification (§2) already ran,
        // so a byte-identical replay of a request accepted before the
        // successor became terminal still returns `idempotent`.
        const successorTerminal = (
          await terminalEventsFor(writer, request.workspace_name, [request.new_node_id])
        ).get(request.new_node_id);
        if (successorTerminal !== undefined) {
          return { outcome: "conflict", reason: "successor_terminal", row: null };
        }

        await writer.refresh(NODE_REVISIONS);
        const successorRevision = await contextOne(
          writer,
          NODE_REVISIONS,
          `workspace_name = ${quote(request.workspace_name)} AND id = ${quote(request.new_revision_id)}` +
            ` AND node_id = ${quote(request.new_node_id)}`,
        );
        if (successorRevision === null) failPublication("integrity_failure", "");
        const encodedSuccessorRevision = encodeRevisionRow(successorRevision);

        return writeLifecycleEventFresh(writer, core, options, writeContextRow.bind(null, writer, core), {
          ...baseInput,
          successor: {
            new_id: request.new_node_id,
            new_revision_id: request.new_revision_id,
            new_title: encodedSuccessorRevision.title as string,
          },
        });
      });
}
