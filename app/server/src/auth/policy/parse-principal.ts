import type { JcsValue } from "../../contracts/jcs";
import { GLOBAL_ACTIONS, MAX_WORKSPACES_PER_PRINCIPAL, PRINCIPAL_KEYS } from "./constants";
import { closed } from "./closed";
import { field } from "./field";
import { parseWorkspaceGrant } from "./parse-workspace-grant";
import { requireActions } from "./require-actions";
import { requireArrayValue } from "./require-array-value";
import { requireBooleanValue } from "./require-boolean-value";
import { requireId } from "./require-id";
import { reject } from "./reject";
import type { PrincipalRecord } from "./types";

export function parsePrincipal(value: JcsValue): PrincipalRecord {
  const o = closed(value, PRINCIPAL_KEYS);
  const id = requireId(field(o, "id"));
  const disabled = requireBooleanValue(field(o, "disabled"));
  const rawWorkspaces = requireArrayValue(field(o, "workspaces"));
  // Collection limits precede element validation.
  if (rawWorkspaces.length > MAX_WORKSPACES_PER_PRINCIPAL) reject("policy_invalid");
  const workspaces = rawWorkspaces.map(parseWorkspaceGrant);
  const globalActions = requireActions(field(o, "global_actions"), GLOBAL_ACTIONS);
  return Object.freeze({
    id,
    disabled,
    workspaces: Object.freeze(workspaces),
    globalActions: Object.freeze(globalActions),
  });
}
