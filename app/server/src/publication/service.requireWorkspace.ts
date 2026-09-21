import { failPublication } from "./errors";
import { quote } from "./storage";
import { WORKSPACES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { type DatasetAdapter } from "./service.types";

export async function requireWorkspace(reader: DatasetAdapter, workspace: string): Promise<void> {
await reader.refresh(WORKSPACES);
    const row = await contextOne(reader, WORKSPACES, `name = ${quote(workspace)}`);
    if (row === null) failPublication("invalid_reference", "/workspace_name");
}
