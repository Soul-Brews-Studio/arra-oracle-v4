import { failRelic } from "./relic.failRelic";

/**
 * Refuses an untrusted string before it becomes a positional `relic` CLI
 * argument. relic's own flag parser does not honor `--` as an
 * end-of-options marker (`agents-relic/src/flags.ts`: any argument starting
 * with `-` is parsed as a FLAG, full stop). Measured probe:
 * `flags(["search", "--data-root=/tmp/elsewhere", "--limit", "100", "--json"])`
 * yields `{f:{"data-root":"/tmp/elsewhere", ...}, pos:["search"]}` -- the
 * query text became a flag that redirects which index root relic reads,
 * and the intended positional query vanished entirely.
 *
 * A real session_uuid, search query, or file path this adapter constructs
 * never legitimately starts with `-`, so refusing it here, before `spawn`,
 * closes that injection path for every caller of `runRelicJson` at once
 * (`relic.getSession.ts`, `relic.findSessions.ts`).
 */
export function assertNotFlagLike(label: string, value: string): void {
  if (value.startsWith("-")) {
    failRelic(
      "bad_output",
      `${label} must not start with "-" -- relic's flag parser would treat it as a flag, ` +
        `not the positional text this adapter means to send: ${JSON.stringify(value)}`,
    );
  }
}
