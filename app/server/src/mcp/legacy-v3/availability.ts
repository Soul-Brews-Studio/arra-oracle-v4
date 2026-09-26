import { KNOWLEDGE_METHODS } from "../../knowledge/registry";
import type { KnowledgeAccess } from "../../knowledge/transport";
import { isDatasetConfigured } from "../../knowledge/transport.isDatasetConfigured";
import { V3_CATALOGUE } from "./catalogue";
import { V3_HANDLERS } from "./handlers";

/**
 * Whether a carried v3 tool can be served right now (docs/overnight/
 * V3-PARITY.md §2.1). The principal's action (rule a) is the service's
 * business; this checks the rest:
 *  (b) a knowledge dataset is configured;
 *  (c) every method in the tool's `requires` list exists in the registry;
 *  and this build has a handler for it.
 * Unavailable tools are not listed; calling one answers `not_yet_available`.
 */
export function availability(name: string, access: KnowledgeAccess | null): { ok: true } | { ok: false; detail: string } {
  const spec = V3_CATALOGUE.find((tool) => tool.name === name);
  if (spec === undefined) return { ok: false, detail: "not a carried v3 tool" };
  if (!isDatasetConfigured(access)) return { ok: false, detail: "knowledge dataset not configured" };
  const missing = spec.requires.filter((method) => !Object.hasOwn(KNOWLEDGE_METHODS, method));
  if (missing.length > 0) return { ok: false, detail: `needs v4 kernel methods not in this build: ${missing.join(", ")}` };
  if (!Object.hasOwn(V3_HANDLERS, name)) return { ok: false, detail: "not implemented in this build" };
  return { ok: true };
}
