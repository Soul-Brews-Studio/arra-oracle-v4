// Shared by calls.recent.ts and calls.aggregate.ts (SQL string literal quoting
// for the LanceDB `where` predicate); split out per Nat style so a shared
// helper is not duplicated across two files.
export const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
