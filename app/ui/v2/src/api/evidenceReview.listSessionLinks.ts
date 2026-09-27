import { type Bank } from "./memory";
import { call } from "./evidenceReview.call";

/** `direction: "from"` finds links this session STARTS (`from_session_name`
 *  = the argument); `"to"` finds links that point AT it. Both directions
 *  matter for evidence review: a session can be evidence FOR another
 *  session's link, not only the other way round. */
export const listSessionLinks = (
  b: Bank,
  session_name: string,
  direction: "from" | "to",
  cursor: string | null,
  limit: number,
) => call(b, "listSessionLinks", { session_name, direction, cursor, limit });
