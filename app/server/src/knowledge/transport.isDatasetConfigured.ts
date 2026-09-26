import type { KnowledgeAccess } from "./transport";

/**
 * Whether a knowledge dataset is configured at all (#31: "unsupported or
 * proposed interfaces are not advertised as live"). `null` means no access
 * was ever configured; the real `createKnowledgeAccess` says `false` when
 * `ARRA_KNOWLEDGE_DATASET_ROOT` is unset. An access that does not say (a test
 * fake with only `getBundle`) serves a dataset, so it counts as configured.
 */
export function isDatasetConfigured(access: KnowledgeAccess | null): boolean {
  return access !== null && access.datasetConfigured !== false;
}
