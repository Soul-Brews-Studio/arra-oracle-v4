// What the call log may record in a NAME column (`session_name`,
// `peer_name`) -- #103 fix round 2, independent verifier, 2026-09-26.
//
// `logCall` used to store the caller's `args.session_name` raw, on the ok
// AND the error path. The R5 reader (`calls.listMcpCalls.ts`) encodes every
// row through the target19 codec, whose `storedName` requires a nonempty,
// well-formed string of at most 256 UTF-8 bytes. The legacy tools accept any
// non-blank string with no length bound (`mcp/index.ts`'s `optionalString`),
// and an empty one is refused by the tool but still AUDITED. So a caller with
// nothing more than `content:read` could write one row the reader cannot
// encode -- measured: `session_name: ""`, or 90 Thai characters (270 bytes)
// -- and every audit read of that workspace became `integrity_failure`.
//
// The rule is therefore the READER's own grammar, applied by calling the
// reader's own function: the writer records only what `storedName` accepts,
// so the two can never drift apart. Anything else is recorded as null and
// flagged (`calls.ts` puts the field name in `h_metadata.invalid_fields`),
// never stored raw and never silently dropped: the attempted value still
// survives, redacted and truncated, inside `h_metadata.input`, where it is
// inert JSON text rather than a typed column a codec must accept.

import { storedName } from "../publication/context.storedName";

export function recordableName(value: string | null | undefined): { value: string | null; invalid: boolean } {
  if (value === null || value === undefined) return { value: null, invalid: false };
  try {
    return { value: storedName(value), invalid: false };
  } catch {
    // `storedName` throws only its fixed `integrity_failure`; there is no
    // message here worth keeping, and none may reach the log anyway.
    return { value: null, invalid: true };
  }
}
