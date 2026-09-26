import { failTaxonomy } from "./taxonomy.failTaxonomy";

/**
 * Raw Arrow cell -> microseconds. `bigint` ONLY.
 *
 * No Date fallback: a Date has already lost whatever sub-millisecond
 * precision the timestamp[us] column held. No `number` fallback either
 * (#105): see `context.rawMicros.ts` for the full rationale -- a plain JS
 * `number` here can only be a lossy MILLISECOND read mistaken for
 * microseconds, and accepting it would silently understate it 1000x instead
 * of failing closed.
 */
export function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return failTaxonomy("integrity_failure");
}
