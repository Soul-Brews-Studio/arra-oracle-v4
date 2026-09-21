import { classifyMessageDestinationReplay } from "../contracts/source-ingestion-v1";
import { reanchorContractError } from "./service.reanchorContractError";

/**
 * Destination check through the ACCEPTED replay wrapper.
 *
 * The wrapper owns destination-before-digest ordering and the exact
 * scope_mismatch text. Calling it -- rather than comparing session names by
 * hand and inventing an error -- is what keeps the envelope identical for
 * sourced and local rows.
 *
 * Local rows carry no source triple, so a synthetic one is supplied purely to
 * reach the destination comparison; the digests are equal, so the wrapper can
 * only return or raise on DESTINATION. It never sees real local content.
 */
export function assertReplayDestination(
  workspace: string,
  session: string,
  stored: Record<string, unknown>,
  itemPrefix: string,
): void {
  const storedNamespace = stored.source_namespace as string | null;
  const sourced = storedNamespace !== null;
  const namespace = sourced ? storedNamespace : "local";
  const messageId = sourced ? (stored.source_message_id as string) : (stored.public_id as string);
  const digest = sourced ? (stored.source_payload_digest as string) : "0".repeat(64);
  try {
    classifyMessageDestinationReplay(
      JSON.stringify({
        requested: { workspace_name: workspace, session_name: session },
        incoming: {
          source_namespace: namespace,
          source_message_id: messageId,
          source_payload_digest: digest,
        },
        existing: {
          workspace_name: stored.workspace_name,
          session_name: stored.session_name,
          source_namespace: namespace,
          source_message_id: messageId,
          source_payload_digest: digest,
          public_id: stored.public_id,
        },
      }),
    );
  } catch (error) {
    reanchorContractError(error, itemPrefix);
  }
}
