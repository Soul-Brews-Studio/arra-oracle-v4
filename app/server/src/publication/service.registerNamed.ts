import { failPublication } from "./errors";
import { quote } from "./storage";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { type Clock, type ContextRegistration, type DatasetAdapter, type OwnerCore } from "./service.types";
import { writeContextRow } from "./service.writeContextRow";

export async function registerNamed(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null }, table: string, workspace: string, requestedId: string, requestedName: string, build: (createdAt: bigint) => Record<string, unknown>, encode: (row: Record<string, unknown>) => Record<string, unknown>, fields: readonly string[]): Promise<ContextRegistration> {
await requireContextWorkspaceRow(writer, workspace);
    await writer.refresh(table);
    const byId = await contextOne(writer, table, `${contextScope(workspace)} AND id = ${quote(requestedId)}`);
    const byName = await contextOne(writer, table, `${contextScope(workspace)} AND name = ${quote(requestedName)}`);

    if (byId !== null) {
      const stored = encode(byId);
      // ID disagreement takes precedence after integrity checks.
      if (stored.name !== requestedName) return { outcome: "conflict", reason: "id" };
      // Same scoped ID+name: already satisfied, retaining the ORIGINAL
      // timestamp and every current optional field. Nothing is rewritten.
      return { outcome: "already_satisfied", row: stored };
    }
    if (byName !== null) return { outcome: "conflict", reason: "name" };

    const createdAt = BigInt(options.clock()) * 1000n;
    const physical = build(createdAt);
    const expected = encode(physical);
    const stored = await writeContextRow(writer, core, 
      table,
      physical,
      async () => {
        const found = await contextOne(writer, table, `${contextScope(workspace)} AND id = ${quote(requestedId)}`);
        if (found === null) {
          core.poison();
          failPublication("recovery_required", "");
        }
        return encode(found);
      },
      expected,
      fields,
      false,
    );
    return { outcome: "created", row: stored };
}
