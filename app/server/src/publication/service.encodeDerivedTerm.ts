import { TERM_FIELDS as TERM_FIELDS_LOCAL } from "./association";
import { decimalOf } from "./service.decimalOf";

/** Stored derived rows decode losslessly; Int64 positions are decimal text. */
export function encodeDerivedTerm(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of TERM_FIELDS_LOCAL) {
    out[field] = field === "position" ? decimalOf(row[field]) : (row[field] ?? null);
  }
  return out;
}
