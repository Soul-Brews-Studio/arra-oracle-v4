import { redact } from "./calls.redact";
import { safeInteger } from "./calls.safeInteger";

/** Inputs are truncated AT WRITE TIME, not at read time — otherwise a 100 KB
 *  argument blob lives in the log forever and is only trimmed when someone
 *  happens to look. */
const MAX_FIELD = 2000;

const jsonSafe = (_key: string, value: unknown) => typeof value === "bigint" ? safeInteger(value) : value;

export const truncate = (v: unknown): string => {
  const safe = redact(v);
  const encoded = typeof safe === "string" ? safe : JSON.stringify(safe ?? null, jsonSafe);
  const s = encoded ?? String(safe);
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[${s.length} chars]` : s;
};
