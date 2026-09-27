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

export function makeReadInstanceAudit<TContext, TPolicy>(
  admitGlobal: (
    authorization: string | null,
    action: "maintenance:backfill" | "maintenance:reindex",
    policy: TPolicy,
    now: number,
  ) => TContext,
  principalOf: (context: TContext) => { principalId: string | null },
  logInstanceAudit: (record: Record<string, unknown>) => Promise<void>,
  snapshot: () => TPolicy,
  clock: () => number,
) {
  // `query` may be a thunk: the HTTP route passes its non-scope parameter
  // parser here so it runs only AFTER admission (frozen contract line 34), and
  // a bad parameter from an admitted operator is audited as an admitted error.
  // `input` is what the audit row records (the raw parameters, not the thunk).
  return (
    authorization: string | null,
    query: InstanceAuditQuery | (() => InstanceAuditQuery),
    input: unknown = query,
  ): Promise<InstanceAuditPage> => {
    const admit = () => admitOperator(admitGlobal, principalOf, authorization, snapshot(), clock());
    const read = () => readInstanceAuditRows(typeof query === "function" ? query() : query);
    return withInstanceAudit(logInstanceAudit, "/api/instance-audit", "instance-audit:read", input, admit, read);
  };
}
