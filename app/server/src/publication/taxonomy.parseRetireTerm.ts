import { parseGetTerm } from "./taxonomy.parseGetTerm";
import type { GetTermRequest } from "./taxonomy.types";

export type RetireTermRequest = GetTermRequest;

export function parseRetireTerm(bytes: Uint8Array): RetireTermRequest {
  return parseGetTerm(bytes);
}
