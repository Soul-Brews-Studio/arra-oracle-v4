import { foldState } from "./connections.state";

export function connectionFoldFailureCount(): number {
  return foldState.foldFailures;
}
