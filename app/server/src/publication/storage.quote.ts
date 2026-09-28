/** Single-quote escaping for SQL literals built from VALIDATED values only. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
