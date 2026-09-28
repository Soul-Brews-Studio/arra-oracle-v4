import type { StoreDependencies } from "./auth/service.createOperationService";

/**
 * #31 maint-audit D4b: the separate instance-level sink for the two global
 * maintenance routes, wired ONLY here -- see `logInstanceAudit`'s field doc
 * on `StoreDependencies` for why no test fixture supplies this.
 */
export async function composeInstanceAuditSink(): Promise<NonNullable<StoreDependencies["logInstanceAudit"]>> {
  const { appendInstanceAuditRow } = await import("./audit/instanceAudit.appendInstanceAuditRow");
  return (record) =>
    appendInstanceAuditRow(
      record as unknown as Parameters<typeof appendInstanceAuditRow>[0],
    );
}
