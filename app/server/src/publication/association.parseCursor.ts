import { fail } from "../contracts/errors";
import { requireClosedObject, requireNanoid21, requireNonemptyString } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { CURSOR_KEYS, type RevisionMode } from "./association.constants";
import { int64Text } from "./association.int64Text";
import { name } from "./association.name";
import { requireMode } from "./association.requireMode";
import type { ScanCursor } from "./association.types";

/** The FIXED message. Never paraphrased: the message is part of the envelope. */
const CURSOR_MISMATCH = "evidence cursor does not match request";

/**
 * Validate the cursor against THIS request.
 *
 * Comparison order is fixed by the contract: workspace_name, target_kind,
 * target_key, revision_mode -- each at its own `/cursor/...` pointer, with the
 * FIXED message. `target_key` is checked against the key this request derives,
 * so a cursor can never act as an alternate raw-key lookup.
 */
export function parseCursor(
  raw: JcsValue,
  request: { workspace_name: string; target_kind: string; target_key: string; revision_mode: RevisionMode },
): ScanCursor {
  const o = requireClosedObject(raw, CURSOR_KEYS, ["cursor"]);
  const mismatch = (field: string): never =>
    fail("scope_mismatch", ["cursor", field], CURSOR_MISMATCH);

  const workspace = name(o.get("workspace_name"), ["cursor", "workspace_name"]);
  if (workspace !== request.workspace_name) mismatch("workspace_name");
  const kind = requireNonemptyString(o.get("target_kind") ?? null, ["cursor", "target_kind"]);
  if (kind !== request.target_kind) mismatch("target_kind");
  const key = requireNonemptyString(o.get("target_key") ?? null, ["cursor", "target_key"]);
  if (key !== request.target_key) mismatch("target_key");
  const mode = requireMode(o.get("revision_mode"), ["cursor", "revision_mode"]);
  if (mode !== request.revision_mode) mismatch("revision_mode");

  // A table version is positive; an ordinal is positive; a position is
  // nonnegative. Each at its own pointer.
  const nodesVersion = int64Text(o.get("nodes_version"), ["cursor", "nodes_version"], "positive");
  const nodeId = requireNanoid21(o.get("node_id") ?? null, ["cursor", "node_id"]);
  const rawRevisionNo = o.get("revision_no");
  const rawPosition = o.get("position");
  const revisionNo =
    rawRevisionNo === null ? null : int64Text(rawRevisionNo, ["cursor", "revision_no"], "positive");
  // Forbidden combination, checked BEFORE the position's own grammar so the
  // structural error is reported rather than a value error on a field that
  // should not be present at all.
  if (revisionNo === null && rawPosition !== null) {
    fail("invalid_value", ["cursor", "position"], "position requires a revision_no");
  }
  const position =
    rawPosition === null ? null : int64Text(rawPosition, ["cursor", "position"], "nonnegative");

  return {
    workspace_name: workspace, target_kind: kind, target_key: key, revision_mode: mode,
    nodes_version: nodesVersion, node_id: nodeId, revision_no: revisionNo, position,
  };
}
