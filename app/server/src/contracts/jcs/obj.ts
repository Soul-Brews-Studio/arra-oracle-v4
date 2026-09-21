import type { JcsObject, JcsValue } from "./types";

/** Build a Map from a plain literal — for constructing envelopes in code, never for parsing input. */
export function obj(entries: Record<string, JcsValue>): JcsObject {
  return new Map(Object.entries(entries));
}
