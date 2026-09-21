import { quote } from "./storage";
import { requireExactlyOne } from "./service.requireExactlyOne";
import { type DatasetAdapter } from "./service.types";

/** Peers, session and workspace: each exactly one scoped row when present. */
export async function validateDomainReferences(
  adapter: DatasetAdapter,
  workspace: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  await requireExactlyOne(adapter, "workspaces", `name = ${quote(workspace)}`, "/content/workspace_name");

  for (const field of ["author_peer_name", "observer_peer_name", "subject_peer_name"] as const) {
    const value = encoded[field];
    if (value === null) continue;
    await requireExactlyOne(
      adapter,
      "peers",
      `workspace_name = ${quote(workspace)} AND name = ${quote(value as string)}`,
      `/content/${field}`,
    );
  }
  if (encoded.session_name !== null) {
    await requireExactlyOne(
      adapter,
      "sessions",
      `workspace_name = ${quote(workspace)} AND name = ${quote(encoded.session_name as string)}`,
      "/content/session_name",
    );
  }
}
