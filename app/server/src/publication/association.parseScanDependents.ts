import { fail } from "../contracts/errors";
import { requireClosedObject } from "../contracts/common";
import { targetOp, type TargetResult } from "../contracts/evidence-v1";
import type { JcsValue } from "../contracts/jcs";
import { MAX_PAGE_LIMIT, type RevisionMode } from "./association.constants";
import { name } from "./association.name";
import { parseCursor } from "./association.parseCursor";
import { parseRequest } from "./association.parseRequest";
import { requireMode } from "./association.requireMode";
import type { ScanCursor } from "./association.types";

export type ScanDependentsRequest = {
  workspace_name: string;
  target_kind: string;
  target: JcsValue;
  target_key: string;
  target_json: string;
  revision_mode: RevisionMode;
  limit: number;
  cursor: ScanCursor | null;
};

export function parseScanDependents(bytes: Uint8Array): ScanDependentsRequest {
  const o = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "target_kind", "target", "revision_mode", "limit", "cursor"],
    [],
  );
  const workspace = name(o.get("workspace_name"), ["workspace_name"]);
  const rawKind = o.get("target_kind") ?? null;
  const rawTarget = o.get("target") ?? null;
  // The ACCEPTED codec validates kind and target together and derives the key.
  // There is no raw caller-supplied target key anywhere in this grammar.
  const derived: TargetResult = targetOp(workspace, rawKind, rawTarget, []);
  const mode = requireMode(o.get("revision_mode"), ["revision_mode"]);

  const rawLimit = o.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }

  const rawCursor = o.get("cursor");
  const cursor =
    rawCursor === null
      ? null
      : parseCursor(rawCursor ?? null, {
          workspace_name: workspace,
          target_kind: rawKind as string,
          target_key: derived.target_key,
          revision_mode: mode,
        });

  return {
    workspace_name: workspace,
    target_kind: rawKind as string,
    target: rawTarget,
    target_key: derived.target_key,
    target_json: derived.target_json,
    revision_mode: mode,
    limit: rawLimit,
    cursor,
  };
}
