import type { JcsValue } from "../contracts/jcs";
import { WORKSPACE_ACTIONS, WORKSPACE_KEYS, WORKSPACE_PEERS_KEY } from "./policy.constants";
import { closed } from "./policy.closed";
import { field } from "./policy.field";
import { requireActions } from "./policy.requireActions";
import { requirePeerNames } from "./policy.requirePeerNames";
import { requireWorkspaceName } from "./policy.requireWorkspaceName";
import type { WorkspaceGrant } from "./policy.types";

export function parseWorkspaceGrant(value: JcsValue): WorkspaceGrant {
  // `peers` (#87 / R3) is optional, so it joins the closed key set only when
  // present; every other key stays required and extras still reject.
  const bound = value instanceof Map && value.has(WORKSPACE_PEERS_KEY);
  const o = closed(value, bound ? [...WORKSPACE_KEYS, WORKSPACE_PEERS_KEY] : WORKSPACE_KEYS);
  const name = requireWorkspaceName(field(o, "name"));
  const actions = requireActions(field(o, "actions"), WORKSPACE_ACTIONS);
  const peers = bound ? Object.freeze(requirePeerNames(field(o, WORKSPACE_PEERS_KEY))) : null;
  return Object.freeze({ name, actions: Object.freeze(actions), peers });
}
