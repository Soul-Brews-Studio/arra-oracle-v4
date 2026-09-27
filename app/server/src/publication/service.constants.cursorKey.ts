import { quote } from "./storage";
import { contextScope } from "./service.contextScope";

export const cursorKey = (workspace: string, peer: string, session: string): string =>
  `${contextScope(workspace)} AND peer_name = ${quote(peer)} AND session_name = ${quote(session)}`;
