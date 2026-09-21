export function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}
