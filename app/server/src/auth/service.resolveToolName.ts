import { V3_TOOL_NAMES } from "../mcp/legacy-v3/catalogue";

/**
 * D6 (docs/overnight/DECISIONS.md R18): an inbound `arra_x` resolves to the
 * carried `oracle_x`, BEFORE the action lookup, so the alias runs under
 * `oracle_x`'s own action and can never pick a cheaper grant. Aliases are
 * never listed. Anything else -- `muninn_*`, an `arra_*` with no carried
 * target, any alias while the family is off -- is returned unchanged and is
 * then as unknown as any other name.
 */
export function resolveToolName(name: string, v3Compat: boolean): { canonical: string; requestedAs: string | null } {
  if (v3Compat && name.startsWith("arra_")) {
    const canonical = `oracle_${name.slice("arra_".length)}`;
    if (V3_TOOL_NAMES.includes(canonical)) return { canonical, requestedAs: name };
  }
  return { canonical: name, requestedAs: null };
}
