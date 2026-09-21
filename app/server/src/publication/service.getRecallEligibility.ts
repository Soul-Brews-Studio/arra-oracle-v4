import { failPublication } from "./errors";
import { parseGetRecallEligibility } from "./lifecycle";
import { toInt64Text } from "./rows";
import { quote } from "./storage";
import { NODES, SUPERSEDE_LOG } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { selectedMaximum } from "./service.selectedMaximum";
import { type DatasetAdapter } from "./service.types";

export async function getRecallEligibility(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ eligible: boolean; witness_event_id: string }> {
const request = parseGetRecallEligibility(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(NODES);
      const node = await contextOne(
        reader,
        NODES,
        `${contextScope(request.workspace_name)} AND id = ${quote(request.node_id)}`,
      );
      if (node === null) failPublication("invalid_reference", "/node_id");

      await reader.refresh(SUPERSEDE_LOG);
      const maxId = await selectedMaximum(
        reader,
        SUPERSEDE_LOG,
        "id",
        contextScope(request.workspace_name),
      );
      const witness = maxId === null ? 0n : maxId;

      const own = await reader.query(
        SUPERSEDE_LOG,
        `${contextScope(request.workspace_name)} AND old_id = ${quote(request.node_id)}`,
        2,
      );
      if (own.length > 1) failPublication("integrity_failure", "");

      return { eligible: own.length === 0, witness_event_id: toInt64Text(witness) };
}
