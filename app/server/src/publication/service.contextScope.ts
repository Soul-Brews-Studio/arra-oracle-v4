import { quote } from "./storage";

export function contextScope(workspace: string): string {
  return `workspace_name = ${quote(workspace)}`;
}
