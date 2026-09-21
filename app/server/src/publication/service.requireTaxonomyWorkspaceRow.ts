import { quote } from "./storage";
import { failTaxonomy } from "./taxonomy";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter } from "./service.types";

export async function requireTaxonomyWorkspaceRow(writer: DatasetAdapter, workspace: string): Promise<void> {
await writer.refresh("workspaces");
    const row = await scopedOne(writer, "workspaces", `name = ${quote(workspace)}`);
    if (row === null) failTaxonomy("invalid_reference", "/workspace_name");
}
