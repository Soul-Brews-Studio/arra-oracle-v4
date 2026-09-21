import { failPublication } from "./errors";
import { type DatasetAdapter, type OwnerCore } from "./service.types";

export async function writeContextRow(writer: DatasetAdapter, core: OwnerCore, table: string, row: Record<string, unknown>, verify: () => Promise<Record<string, unknown>>, expected: Record<string, unknown>, fields: readonly string[], wroteAlready: boolean): Promise<Record<string, unknown>> {
await core.contextBoundary("before_write", wroteAlready);
    core.markAttemptedWrite();
    try {
      await writer.append(table, [row]);
    } catch {
      core.poison();
      failPublication("recovery_required", "");
    }
    await core.contextBoundary("after_write", true);
    const stored = await core.afterWrite(async () => {
      await writer.refresh(table);
      const found = await verify();
      // COMPARE every physical field. Decoding proves structural validity and
      // says nothing about whether the row holds what was asked for.
      for (const field of fields) {
        if (found[field] !== expected[field]) {
          core.poison();
          failPublication("recovery_required", "");
        }
      }
      return found;
    });
    await core.contextBoundary("after_readback", true);
    return stored;
}
