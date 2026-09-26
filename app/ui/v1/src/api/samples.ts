/** Starter request bodies, keyed by method.
 *
 * These are SHAPES, not valid data -- ids are placeholders and most will come
 * back `invalid_reference` until you point them at rows that exist. That is
 * the intended POC behaviour: seeing the real refusal envelope is the point.
 */
export function sampleBody(method: string, workspace: string): string {
  const ws = { workspace_name: workspace };
  const pick = (extra: Record<string, unknown>) => JSON.stringify({ ...ws, ...extra }, null, 2);

  switch (method) {
    case "getPeer":
      return pick({ peer_name: "alice" });
    case "getSession":
      return pick({ session_name: "sess-a" });
    // #87 / R3: requester_peer_name is optional. null (or omitted) is the
    // operator view and needs audit:read; a peer name must be a current member.
    case "getMessage":
      return pick({ public_id: "", requester_peer_name: null });
    case "listMessages":
      return pick({ session_name: "sess-a", limit: 20, after_seq: null, requester_peer_name: null });
    case "getContext":
      return pick({ peer_name: "alice", session_name: "sess-a", max_items: 10 });
    case "answerChat":
      return pick({ peer_name: "alice", session_name: "sess-a", question: "what changed?", max_items: 10 });
    case "registerPeer":
      return pick({ peer_name: "alice" });
    case "registerSession":
      return pick({ session_name: "sess-a" });
    case "joinSession":
      return pick({ session_name: "sess-a", peer_name: "alice" });
    case "getReadCursor":
      return pick({ peer_name: "alice", session_name: "sess-a" });
    case "getVocabulary":
      return pick({ vocabulary_name: "type" });
    case "getTerm":
      return pick({ vocabulary_name: "type", term_name: "note" });
    case "createVocabulary":
      return pick({ vocabulary_name: "topics", label: "Topics", kind: "tags" });
    case "seedReservedVocabularies":
      return pick({});
    case "getAcceptedHead":
    case "listAcceptedHistory":
      return pick({ node_id: "" });
    case "getRevisionAssociations":
      return pick({ revision_id: "" });
    case "scanDependents":
      return pick({ target_kind: "trace", target_key: "", limit: 20, cursor: null });
    default:
      return pick({});
  }
}
