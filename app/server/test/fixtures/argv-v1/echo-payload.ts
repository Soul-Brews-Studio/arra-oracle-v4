// Owned child for `harness-argv-limit.test.ts`: reports what it was really
// started with, so the parent can check the Linux per-string argv limit on a
// platform that does not enforce it.
//
// argv: <label> <payload>. Prints one JSON line:
//   argvBytes   UTF-8 byte length of every argv string AFTER the script path,
//               exactly as exec delivered them (before any decoding)
//   rawPayload  the payload argument as delivered, cut to 200 characters
//   payloadBytes / payloadSha256   of the DECODED payload
//   gated       whether this process holds the writer gate's inherited fd
import { createHash } from "node:crypto";
import { readArgPayload } from "../../helpers/argv.readArgPayload";

const [, , label, rawPayload] = process.argv;
const payload = readArgPayload(rawPayload) ?? "";
console.log(
  JSON.stringify({
    label,
    argvBytes: process.argv.slice(2).map((arg) => Buffer.byteLength(arg, "utf8")),
    rawPayload: (rawPayload ?? "").slice(0, 200),
    payloadBytes: Buffer.byteLength(payload, "utf8"),
    payloadSha256: createHash("sha256").update(payload, "utf8").digest("hex"),
    gated: process.env.ARRA_WRITER_FD !== undefined,
  }),
);
