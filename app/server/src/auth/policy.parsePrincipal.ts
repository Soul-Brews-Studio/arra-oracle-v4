import type { JcsValue } from "../contracts/jcs";
import { GLOBAL_ACTIONS, MAX_WORKSPACES_PER_PRINCIPAL, PRINCIPAL_KEYS } from "./policy.constants";
import { closed } from "./policy.closed";
import { field } from "./policy.field";
import { parseWorkspaceGrant } from "./policy.parseWorkspaceGrant";
import { requireActions } from "./policy.requireActions";
import { requireArrayValue } from "./policy.requireArrayValue";
import { requireBooleanValue } from "./policy.requireBooleanValue";
import { requireId } from "./policy.requireId";
import { reject } from "./policy.reject";
import type { PrincipalRecord } from "./policy.types";

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
