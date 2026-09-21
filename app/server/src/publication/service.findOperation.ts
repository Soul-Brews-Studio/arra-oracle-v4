import { quote } from "./storage";
import { exactlyOne } from "./service.exactlyOne";
import { type DatasetAdapter, type RevisionRow } from "./service.types";

export async function findOperation(
  reader: DatasetAdapter,
  workspace: string,
  operationId: string,
): Promise<RevisionRow | null> {
  const rows = await reader.query(
    "node_revisions",
    `workspace_name = ${quote(workspace)} AND operation_id = ${quote(operationId)}`,
  );
  return exactlyOne(rows);
}
