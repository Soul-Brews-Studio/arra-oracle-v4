import { failPublication } from "./errors";
import { storedNonemptyText } from "./trace.storedNonemptyText";
import { TRACE_STATUSES, type TraceStatus } from "./trace.types";

export function storedStatus(value: unknown): TraceStatus {
  const text = storedNonemptyText(value);
  if (!(TRACE_STATUSES as readonly string[]).includes(text)) failPublication("integrity_failure", "");
  return text as TraceStatus;
}
