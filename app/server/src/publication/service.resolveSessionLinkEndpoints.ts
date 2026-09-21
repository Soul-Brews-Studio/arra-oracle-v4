import { encodeSessionRow } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { SESSIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * Resolve both endpoints, IN ORDER, each at its own pointer. EXISTENCE ONLY:
 * an inactive or historical session is a legitimate endpoint, exactly as read
 * cursors permit historical access -- session links are annotations about a
 * relationship, not new conversational content, so appendMessages' active-
 * membership rule is deliberately NOT inherited here.
 */
export async function resolveSessionLinkEndpoints(
  adapter: DatasetAdapter,
  workspace: string,
  fromSession: string,
  toSession: string,
): Promise<void> {
  await adapter.refresh(SESSIONS);
  const from = await contextOne(
    adapter,
    SESSIONS,
    `${contextScope(workspace)} AND name = ${quote(fromSession)}`,
  );
  if (from === null) failPublication("invalid_reference", "/from_session_name");
  encodeSessionRow(from);

  const to = await contextOne(
    adapter,
    SESSIONS,
    `${contextScope(workspace)} AND name = ${quote(toSession)}`,
  );
  if (to === null) failPublication("invalid_reference", "/to_session_name");
  encodeSessionRow(to);
}
