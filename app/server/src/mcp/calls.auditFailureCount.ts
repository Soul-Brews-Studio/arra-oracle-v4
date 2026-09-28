import { auditFailuresState } from "./calls.state";

export function auditFailureCount(): number {
  return auditFailuresState.count;
}
