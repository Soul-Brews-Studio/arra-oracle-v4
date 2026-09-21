import type { Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { failTaxonomy } from "./taxonomy.failTaxonomy";
import { requireName } from "./taxonomy.requireName";

/** The existing nonblank workspace grammar: nonempty AFTER trimming, 256 bytes. */
export function requireWorkspace(value: JcsValue | undefined, tokens: Tokens = ["workspace_name"]): string {
  const text = requireName(value, tokens);
  if (text.trim().length === 0) failTaxonomy("invalid_request", "/workspace_name");
  return text;
}
