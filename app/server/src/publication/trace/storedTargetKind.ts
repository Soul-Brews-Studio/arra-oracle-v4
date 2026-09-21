import { failPublication } from "../errors";
import { storedNonemptyText } from "./storedNonemptyText";
import { TARGET_KINDS, type TargetKind } from "../../contracts/evidence-v1";

export function storedTargetKind(value: unknown): TargetKind {
  const text = storedNonemptyText(value);
  if (!(TARGET_KINDS as readonly string[]).includes(text)) failPublication("integrity_failure", "");
  return text as TargetKind;
}
