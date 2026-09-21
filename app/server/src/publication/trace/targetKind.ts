import { requireEnum, type Tokens } from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";
import { TARGET_KINDS, type TargetKind } from "../../contracts/evidence-v1";

export function targetKind(value: JcsValue | undefined, tokens: Tokens): TargetKind {
  return requireEnum(value ?? null, TARGET_KINDS, tokens);
}
