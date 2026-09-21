import { quote } from "./storage";
import { exactlyOne } from "./service.exactlyOne";
import { type DatasetAdapter } from "./service.types";

export async function findNode(reader: DatasetAdapter, workspace: string, nodeId: string) {
  const rows = await reader.query(
    "nodes",
    `workspace_name = ${quote(workspace)} AND id = ${quote(nodeId)}`,
  );
  return exactlyOne(rows);
}
