import { useMemo } from "react";
import type { Bank } from "../api/memory";

/** One `Bank` object per distinct bank/workspace/token, so a hook that keys a
 *  fetch on it refetches when the SCOPE or credential changes and not when a
 *  parent rebuilds an equal object inline. App.tsx did exactly that, and every
 *  App render re-read the node on screen -- the second in-flight request the
 *  ui-stale race needed (docs/overnight/UI-PROOF-ui-stale.md). */
export function useStableBank(b: Bank): Bank {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ bank: b.bank, token: b.token, workspace: b.workspace }), [b.bank, b.token, b.workspace]);
}
