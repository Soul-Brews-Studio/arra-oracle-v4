// Shared SQL-string-literal quoting for the LanceDB `where` predicates built
// across the split db.* files (searchText, searchVector, list, getById, stats).
export const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
