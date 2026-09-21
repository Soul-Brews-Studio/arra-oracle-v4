import type { JcsValue } from "../../contracts/jcs";
import { WORKSPACE_ACTIONS, WORKSPACE_KEYS } from "./constants";
import { closed } from "./closed";
import { field } from "./field";
import { requireActions } from "./require-actions";
import { requireWorkspaceName } from "./require-workspace-name";
import type { WorkspaceGrant } from "./types";

export function parseWorkspaceGrant(value: JcsValue): WorkspaceGrant {
  const o = closed(value, WORKSPACE_KEYS);
  const name = requireWorkspaceName(field(o, "name"));
  const actions = requireActions(field(o, "actions"), WORKSPACE_ACTIONS);
  return Object.freeze({ name, actions: Object.freeze(actions) });
}
