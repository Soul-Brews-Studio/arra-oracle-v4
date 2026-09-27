import { quote } from "./storage";

export const scopeOf = (workspace: string) => `workspace_name = ${quote(workspace)}`;
