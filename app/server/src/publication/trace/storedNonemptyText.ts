import { failPublication } from "../errors";
import { storedText } from "./storedText";

export function storedNonemptyText(value: unknown): string {
  const text = storedText(value);
  if (text.length === 0) failPublication("integrity_failure", "");
  return text;
}
