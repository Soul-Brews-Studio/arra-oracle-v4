import type { TransportRejection } from "./http.types";

// Shared by checkHostAndOrigin, checkBodyEncoding and readBoundedBody.
export const reject = (status: number, error: string): TransportRejection => Object.freeze({ status, error });
