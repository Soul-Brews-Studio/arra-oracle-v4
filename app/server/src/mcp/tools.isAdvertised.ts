import type { KnowledgeAccess } from "../knowledge/transport";
import { isDatasetConfigured } from "../knowledge/transport.isDatasetConfigured";
import { V3_TOOL_NAMES } from "./legacy-v3/catalogue";
import { availability } from "./legacy-v3/availability";

/**
 * #31: "unsupported or proposed interfaces are not advertised as live."
 * The service decides which tools a principal MAY call; this only hides the
 * ones this deployment cannot serve. `kb_*` needs a configured dataset
 * (parity defect 5); a v3 tool needs its full availability rule. Hiding never
 * widens anything: a hidden tool is still admitted, or refused, exactly as
 * before.
 */
export function isAdvertised(name: string, access: KnowledgeAccess | null): boolean {
  if (name.startsWith("kb_")) return isDatasetConfigured(access);
  if (V3_TOOL_NAMES.includes(name)) return availability(name, access).ok;
  return true;
}
