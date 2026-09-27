/**
 * A plain-object copy of a strictly parsed JSON object (the JCS strict
 * parser's `parseStrict`), for the code that needs ordinary property access: the MCP
 * envelope reader and `POST /api/memories`' audit input (#31 legacy-audit).
 *
 * It cannot fail on a parsed body. The strict parser yields only null,
 * booleans, finite numbers, strings, arrays and Maps, and `JSON.stringify`
 * throws on none of them; so there is deliberately no fallback. An earlier
 * `catch {}` around this copy was dead, and had it ever fired the audit row
 * would have recorded input `{}` with nothing to show the input was lost (#31
 * maint-audit). `Object.fromEntries` and `JSON.parse` both define keys as own
 * data properties, so a `__proto__` key is copied as data, never a prototype.
 */
export function plainBody(document: Map<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(document, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v)));
}
