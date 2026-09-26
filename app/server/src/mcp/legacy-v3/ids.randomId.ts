import { randomBytes } from "node:crypto";

/** A fresh nanoid21 (A8: ids are random unless the caller asks to replay). */
export function randomId(): string {
  return randomBytes(16).toString("base64url").slice(0, 21);
}
