import type { JcsValue } from "../contracts/jcs";
import { WORKSPACE_ACTIONS, WORKSPACE_KEYS } from "./policy.constants";
import { closed } from "./policy.closed";
import { field } from "./policy.field";
import { requireActions } from "./policy.requireActions";
import { requireWorkspaceName } from "./policy.requireWorkspaceName";
import type { WorkspaceGrant } from "./policy.types";

export function parseWorkspaceGrant(value: JcsValue): WorkspaceGrant {
  const o = closed(value, WORKSPACE_KEYS);
  const name = requireWorkspaceName(field(o, "name"));
  const actions = requireActions(field(o, "actions"), WORKSPACE_ACTIONS);
  return Object.freeze({ name, actions: Object.freeze(actions) });
}
