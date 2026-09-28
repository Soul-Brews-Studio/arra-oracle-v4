import { createOperationService, type OperationService, type StoreDependencies } from "./auth/service.createOperationService";
import type { KnowledgeAccess } from "./knowledge/transport";
import type { RuntimeConfig } from "./composition.constants";
import { composeAuditSink } from "./composition.composeAuditSink";
import { composeInstanceAuditSink } from "./composition.composeInstanceAuditSink";

/**
 * Build the operation service over the real store/embedder/audit modules.
 *
 * These are imported lazily and deliberately: adapters never see these handles,
 * only the credential-taking service returned here.
 */
export async function composeService(
  config: RuntimeConfig,
  knowledgeAccess: KnowledgeAccess | null = null,
): Promise<OperationService> {
  const store = await import("./db");
  const embed = await import("./embed");
  const calls = await import("./mcp/calls");
  const { validateType } = await import("./mcp/remember.validateType");

  const deps: StoreDependencies = {
    insert: (row) => store.insert(row),
    // D5a HTTP parity (#31 AC-MATRIX row 111): the exact same helper MCP
    // `remember` calls (`mcp/remember.validateType.ts`), given the SAME
    // knowledge access `buildApp` composes below -- not a second one, so an
    // unconfigured `ARRA_KNOWLEDGE_DATASET_ROOT` bypasses identically on
    // both transports rather than one failing closed and the other silently
    // skipping. `knowledgeAccess` is `null` only in compositions that never
    // call this (e.g. isolated `insert`-only tests); production always
    // passes the real one from `buildApp`.
    validateType: (bank, authority, type) => validateType(knowledgeAccess, bank, authority, type),
    list: (bank, limit, filters) => store.list(bank, limit, filters as never),
    searchText: (q, bank, limit) => store.searchText(q, bank, limit),
    searchVector: (q, bank, limit) => store.searchVector(q, bank, limit),
    getById: (bank, id) => store.getById(bank, id),
    stats: (bank) => store.stats(bank) as Promise<Record<string, unknown>>,
    backfill: (batch) => store.backfill(batch),
    ensureFtsIndex: (replace) => store.ensureFtsIndex(replace),
    embedHealth: () => embed.health(),
    recentCalls: (bank, limit, status) => calls.recent(bank, limit, status),
    aggregateCalls: (bank) => calls.aggregate(bank),
    logCall: await composeAuditSink(),
    // #31 maint-audit D4b: the SEPARATE instance-level sink for the two
    // global maintenance routes -- only wired here, in the real composition,
    // never touched by a test's stub `StoreDependencies` (`service.types.ts`
    // field doc has the regression this avoided).
    logInstanceAudit: await composeInstanceAuditSink(),
  };

  return createOperationService({ policyPath: config.policyPath, v3Compat: config.v3Compat === true }, deps);
}
