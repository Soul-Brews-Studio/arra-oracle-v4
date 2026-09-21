import { failPublication } from "./errors";
import { storedInt64Text } from "./trace.storedInt64Text";

/**
 * `depth` and `position` are int64 columns this service can only ever WRITE
 * as >= 0 (`requireNonNegativeInt64String` at request grammar for `depth`;
 * `BigInt(i)` with `i >= 0` for `position`). A stored negative is state this
 * service could never have produced -- integrity_failure, per the same rule
 * `read-cursor.ts`'s `storedName` applies to its own writer-bounded columns.
 */
export function storedNonNegativeInt64Text(value: unknown): string {
  const text = storedInt64Text(value);
  if (text.startsWith("-")) failPublication("integrity_failure", "");
  return text;
}
