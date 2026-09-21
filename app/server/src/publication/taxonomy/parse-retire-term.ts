import { parseGetTerm } from "./parse-get-term";
import type { GetTermRequest } from "./types";

export type RetireTermRequest = GetTermRequest;

export function parseRetireTerm(bytes: Uint8Array): RetireTermRequest {
  return parseGetTerm(bytes);
}
