import { type Bank } from "./memory";
import { call } from "./evidenceReview.call";

/** `revision_id: null` means the CAPTURED HEAD (`association-evidence-v1.md`
 *  §2) -- distinct from omitting the key, so this always sends the key,
 *  explicitly null when no exact revision was picked. */
export const getRevisionAssociations = (b: Bank, node_id: string, revision_id: string | null) =>
  call(b, "getRevisionAssociations", { node_id, revision_id });
