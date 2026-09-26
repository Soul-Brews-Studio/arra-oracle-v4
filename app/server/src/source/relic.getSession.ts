import { failRelic } from "./relic.errors";
import { runRelicJson } from "./relic.runRelicJson";
import { rowToSessionRef } from "./relic.rowToSessionRef";
import type { RelicAdapterConfig, RelicSessionCommandOutput } from "./relic.types";
import type { SessionRef } from "./session-source.types";

/**
 * `SessionSource.get`: `relic session <id> --json`. Absence (relic found no
 * matching transcript at all) is `null` -- never thrown -- matching the rest
 * of this codebase's "absence is null, not an error" convention
 * (`trace-v1.md` section 6: "getTrace returns the literal row or null").
 */
export async function getSession(config: RelicAdapterConfig, sessionId: string): Promise<SessionRef | null> {
  const raw = await runRelicJson(config, ["session", sessionId]);
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { sessions?: unknown }).sessions)) {
    failRelic("bad_output", "relic session output missing sessions array");
  }
  const output = raw as RelicSessionCommandOutput;
  if (output.sessions.length === 0) return null;
  return rowToSessionRef(output.sessions[0]!);
}
