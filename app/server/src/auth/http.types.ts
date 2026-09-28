// Shared types + data for the auth/http.* transport helpers (#22
// style-split4a split of auth/http.ts). DATA/TYPES ONLY -- no functions.
export type TransportRejection = { readonly status: number; readonly error: string };

export type RawBody = { readonly bytes: Uint8Array } | TransportRejection;

/** Fixed, small, secret-free bodies. Never echoes caller content. */
export const ERROR_BODIES: Readonly<Record<number, { error: string }>> = Object.freeze({
  400: { error: "bad request" },
  401: { error: "unauthenticated" },
  403: { error: "forbidden" },
  413: { error: "payload too large" },
  415: { error: "unsupported media type" },
  503: { error: "policy unavailable" },
});
