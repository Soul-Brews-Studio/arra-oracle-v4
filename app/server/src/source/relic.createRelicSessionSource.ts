import { findSessions } from "./relic.findSessions";
import { getSession } from "./relic.getSession";
import { readSession } from "./relic.readSession";
import type { RelicAdapterConfig } from "./relic.types";
import type { SessionSource } from "./session-source.types";

/**
 * The relic-CLI-subprocess implementation of `SessionSource`
 * (docs/overnight/DECISIONS.md R7: "The Relic adapter is a relic CLI
 * subprocess returning JSON, behind an interface with a fake in tests").
 * Pure composition -- every method here is a thin, already-tested function
 * from a sibling `relic.*.ts` module; this file adds no logic of its own so
 * there is exactly one place (`relic.runRelicJson.ts`) that ever spawns.
 */
export function createRelicSessionSource(config: RelicAdapterConfig): SessionSource {
  return {
    find: (query, limit) => findSessions(config, query, limit),
    get: (sessionUuid) => getSession(config, sessionUuid),
    read: (sessionUuid, options) => readSession(config, sessionUuid, options),
  };
}
