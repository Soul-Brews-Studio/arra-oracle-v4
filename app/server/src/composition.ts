/**
 * Trusted startup composition (`authorization-integration-v1.md` §3).
 *
 * This is the ONLY module that wires raw data, model and audit dependencies
 * into the facade. It is not an HTTP or MCP adapter and exposes no anonymous
 * operation API.
 *
 * Importing this module performs no configuration reading, no file or store
 * access and no listening. The raw modules are imported lazily inside the
 * builder so that merely importing the composition graph cannot trigger their
 * import-time environment reads.
 *
 * style-split6 (2026-09-28, docs/overnight/DECISIONS.md, Nat style: one
 * exported function per file, named after the file): this file is now a
 * pure re-export BARREL. Every exported function/type/constant moved
 * verbatim to `composition.<name>.ts` (or the data-only `composition.constants.ts`
 * for the plain types/constants), so no importer of `./composition` churns.
 * No value-level cycle runs through this barrel: each split file imports
 * only its own siblings directly, never `./composition` itself.
 */

export type { RuntimeConfig, VersionCheck } from "./composition.constants";
export { SUPPORTED_BUN, SUPPORTED_ELYSIA, GLOBAL_BODY_BACKSTOP } from "./composition.constants";
export { readInstalledElysiaVersion } from "./composition.readInstalledElysiaVersion";
export { checkSupportedRuntime } from "./composition.checkSupportedRuntime";
export { readConfig } from "./composition.readConfig";
export { composeAuditSink } from "./composition.composeAuditSink";
export { composeInstanceAuditSink } from "./composition.composeInstanceAuditSink";
export { composeService } from "./composition.composeService";
export { composeV3Compat } from "./composition.composeV3Compat";
export { composeKnowledgeAccess } from "./composition.composeKnowledgeAccess";
export { checkChatConfig } from "./composition.checkChatConfig";
export { runStartupIndexWork } from "./composition.runStartupIndexWork";
