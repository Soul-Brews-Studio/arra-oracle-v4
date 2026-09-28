// Split from transport.ts (style-split4b, 2026-09-28).
import type { TransportRejection } from "../auth/http";
import type { RawBody } from "./transport.state";

export const isRejection = (value: RawBody): value is TransportRejection =>
  (value as TransportRejection).status !== undefined;
