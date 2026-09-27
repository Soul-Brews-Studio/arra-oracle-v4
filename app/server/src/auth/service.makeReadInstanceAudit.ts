/**
 * #31 R25 (Nat D4b): builds the `readInstanceAudit` operation, factored out
 * of `service.createOperationService.ts` for the file-size cap. Grant choice
 * lives in `service.admitOperator.ts`; the read itself is audited to the same
 * sink it reads (state per R25: yes) -- `withInstanceAudit` gives one row
 * whether admitted or refused, matching `backfill`/`reindex` exactly.
 */

import { admitOperator } from "./service.admitOperator";
import { withInstanceAudit } from "./service.withInstanceAudit";
import { readInstanceAuditRows, type InstanceAuditPage, type InstanceAuditQuery } from "../audit/instanceAudit.readInstanceAuditRows";

export function makeReadInstanceAudit<TContext>(
  admitGlobal: (authorization: string | null, action: "maintenance:backfill" | "maintenance:reindex") => TContext,
  principalOf: (context: TContext) => { principalId: string | null },
  logInstanceAudit: (record: Record<string, unknown>) => Promise<void>,
) {
  return (authorization: string | null, query: InstanceAuditQuery): Promise<InstanceAuditPage> => {
    const admit = () => admitOperator(admitGlobal, principalOf, authorization);
    const read = () => readInstanceAuditRows(query);
    return withInstanceAudit(logInstanceAudit, "/api/instance-audit", "instance-audit:read", query, admit, read);
  };
}
