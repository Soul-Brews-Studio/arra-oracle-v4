import { quote } from "./storage";
import { exactlyOne } from "./service.exactlyOne";
import { type DatasetAdapter, type RevisionRow } from "./service.types";

export async function findRevisionById(
  reader: DatasetAdapter,
  workspace: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  const rows = await reader.query(
    "node_revisions",
    `workspace_name = ${quote(workspace)} AND id = ${quote(revisionId)}`,
  );
  return exactlyOne(rows);
}
