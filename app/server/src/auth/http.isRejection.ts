import type { RawBody, TransportRejection } from "./http.types";

export const isRejection = (value: RawBody): value is TransportRejection =>
  (value as TransportRejection).status !== undefined;
