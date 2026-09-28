import { Type } from "apache-arrow";
import { failPublication } from "./errors";

/**
 * Render an Arrow type in the golden's exact vocabulary.
 *
 * Keyed off the INSTALLED `Type` enum, matching the measured descriptor the
 * cross-language schema test already proves out. An earlier version here just
 * lowercased `type.toString()`, which collapsed every timestamp unit and
 * timezone into `timestamp[us]` and mis-spelled nested types -- so genuine
 * drift would have been accepted silently. An unknown type THROWS rather than
 * inventing a token: a type we cannot name is one we cannot verify.
 */
function describeType(type: {
  typeId: number;
  isSigned?: boolean;
  bitWidth?: number;
  precision?: number;
  unit?: number;
  timezone?: string | null;
  listSize?: number;
  children?: { type: unknown; nullable: boolean }[];
  toString(): string;
}): string {
  switch (type.typeId) {
    case Type.Bool:
      return "bool";
    case Type.Int:
      return `${type.isSigned ? "" : "u"}int${type.bitWidth}`;
    case Type.Float: {
      const precision: Record<number, string> = { 1: "float32", 2: "float64" };
      const rendered = precision[type.precision as number];
      if (!rendered) failPublication("unsupported_dataset");
      return rendered;
    }
    case Type.Utf8:
      return "utf8";
    case Type.LargeUtf8:
      // 64-bit offsets: a DIFFERENT physical type, never folded into utf8.
      return "large_utf8";
    case Type.Timestamp: {
      const unit = ["s", "ms", "us", "ns"][type.unit as number];
      if (!unit) failPublication("unsupported_dataset");
      return type.timezone == null ? `timestamp[${unit}]` : `timestamp[${unit},${type.timezone}]`;
    }
    case Type.List:
      return `list<${describeChild(type)}>`;
    case Type.FixedSizeList:
      return `fixed_size_list<${describeChild(type)}>[${type.listSize}]`;
    default:
      return failPublication("unsupported_dataset");
  }
}

function describeChild(type: { children?: { type: unknown; nullable: boolean }[] }): string {
  const field = type.children?.[0];
  if (!field) return failPublication("unsupported_dataset");
  return `${describeType(field.type as never)}${field.nullable ? "?" : ""}`;
}

/** Field descriptor: type spelling plus nullability, as the golden records it. */
export function describeField(field: { type: unknown; nullable: boolean }): string {
  return describeType(field.type as never);
}
