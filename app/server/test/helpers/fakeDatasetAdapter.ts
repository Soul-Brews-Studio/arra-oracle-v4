// A minimal in-memory `DatasetAdapter` for the K6/K7 bounded-scan tests
// (`test/taxonomy-term-usage-scans.test.ts`). Fast and deterministic: the only
// practical way to exercise a 1000+-row window without writing 1000+ real
// rows through the gate. It is a fake, not a SQL engine.
//
// Every `col = 'value'` clause of a predicate is honoured, which is every
// clause shape `service.listTermUsage.ts`, `service.knowledgeStats.ts`,
// `service.listTerms.ts` and `service.requireWorkspace.ts` build (`scopeOf`,
// `id = ...`, `name = ...`, `vocabulary_id = ...`). Any other clause shape is
// ignored, NOT rejected -- so a kernel that DROPS its workspace scope sees
// every workspace's rows here, which is exactly what the isolation tests
// need to notice.

import { type DatasetAdapter } from "../../src/publication/service.types";

function matchesPredicate(row: Record<string, unknown>, predicate: string): boolean {
  for (const clause of predicate.split(" AND ")) {
    const m = /^(\w+) = '((?:[^']|'')*)'$/.exec(clause.trim());
    if (m === null) continue;
    const value = m[2]!.replace(/''/g, "'");
    if (String(row[m[1]!]) !== value) return false;
  }
  return true;
}

export function fakeDatasetAdapter(tables: Record<string, Record<string, unknown>[]>): DatasetAdapter {
  const notImplemented = (): Promise<never> => Promise.reject(new Error("not implemented in this fake"));
  return {
    async query(table: string, predicate: string, limit?: number) {
      const rows = (tables[table] ?? []).filter((row) => matchesPredicate(row, predicate));
      return limit === undefined ? rows : rows.slice(0, limit);
    },
    async orderedProjection(table: string, predicate: string, columns: string[], ordering: { column: string; ascending: boolean }, limit: number) {
      const rows = (tables[table] ?? []).filter((row) => matchesPredicate(row, predicate));
      rows.sort((a, b) => {
        const av = a[ordering.column] as string;
        const bv = b[ordering.column] as string;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return ordering.ascending ? cmp : -cmp;
      });
      return rows.slice(0, limit).map((row) => Object.fromEntries(columns.map((c) => [c, row[c]])));
    },
    async count(table: string, predicate: string) {
      return (tables[table] ?? []).filter((row) => matchesPredicate(row, predicate)).length;
    },
    async refresh() {},
    version: notImplemented,
    deleteDerivedScope: notImplemented,
    append: notImplemented,
    updateWhere: notImplemented,
    updateSearchChunkEmbedding: notImplemented,
    release() {},
  };
}
