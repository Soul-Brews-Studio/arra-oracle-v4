import { fail } from "../../contracts/errors";
import type { JcsValue } from "../../contracts/jcs";
import type { Tokens } from "../../contracts/common";
import { REVISION_MODES, type RevisionMode } from "./constants";

export function requireMode(value: JcsValue | undefined, tokens: Tokens): RevisionMode {
  if (typeof value !== "string") fail("invalid_type", tokens, "expected string");
  if (!(REVISION_MODES as readonly string[]).includes(value)) {
    fail("invalid_value", tokens, `expected one of ${REVISION_MODES.join(", ")}`);
  }
  return value as RevisionMode;
}
