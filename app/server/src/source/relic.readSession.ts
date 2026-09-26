import { failRelic } from "./relic.errors";
import { getSession } from "./relic.getSession";
import { runRelicJson } from "./relic.runRelicJson";
import type { RelicAdapterConfig, RelicTailCommandOutput, RelicTailTurn } from "./relic.types";
import type { ReadOptions, SourceExcerpt } from "./session-source.types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function turnToExcerpt(turn: RelicTailTurn, transcriptRef: string): SourceExcerpt {
  if (
    typeof turn.seq !== "number" ||
    typeof turn.role !== "string" ||
    typeof turn.text !== "string" ||
    typeof turn.ts !== "string"
  ) {
    failRelic("bad_output", "relic tail turn missing seq/role/text/ts");
  }
  return { eventSeq: turn.seq, speaker: turn.role, content: turn.text, sourceTime: turn.ts, transcriptRef };
}

/**
 * `SessionSource.read`: resolves `sessionUuid` to its transcript file path
 * via `getSession` (read-only, `--no-index`, exact-uuid, tier:"session"
 * match), THEN runs `relic tail <file_path> -n <limit> --json` -- NEVER
 * `relic tail <sessionUuid>` directly.
 *
 * Why: measured against `agents-relic/src/cli.ts`'s `cmdTail`, a bare id
 * argument (one with no `/`) is resolved through the SAME import-on-miss
 * `resolveSession` path `session` uses -- `cmdTail` passes `{noIndex:true}`
 * as a THIRD argument, but `resolveSession`'s signature takes only two
 * parameters, so that flag is silently dropped and has no effect; no flag
 * on `tail` suppresses the import. A target CONTAINING `/`, by contrast, is
 * read directly as a file path with no index lookup at all
 * (`!target.includes("/")` gates the whole resolve step). Resolving through
 * `getSession` first and tailing the resulting path is what keeps this call
 * read-only end to end -- see the contract's "isolation" section.
 *
 * A session `getSession` cannot resolve without indexing (e.g. a real,
 * recently started, not-yet-indexed session, or an id/name that does not
 * exactly identify one top-level session) is reported as `not_found` --
 * never silently answered by falling back to an unsafe `tail` call.
 *
 * `options.from` is refused rather than silently ignored when set
 * (`bad_output` -- there is no lower error code for "this provider cannot do
 * what you asked", and no request ever reaches this adapter directly, so no
 * transport status mapping is needed): `relic tail` has no seq-offset
 * pagination, and a caller asking to resume from a specific point deserves a
 * clear refusal, not a page that silently starts somewhere else. See the
 * contract's "failure modes" section.
 */
export async function readSession(
  config: RelicAdapterConfig,
  sessionUuid: string,
  options: ReadOptions = {},
): Promise<SourceExcerpt[]> {
  if (options.from !== undefined && options.from !== null) {
    failRelic("bad_output", "relic-backed read() has no seq-offset pagination; `from` must be omitted");
  }
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const session = await getSession(config, sessionUuid);
  if (session === null) {
    failRelic("not_found", `no indexed session matches ${JSON.stringify(sessionUuid)} (read-only: relic was not asked to index it)`);
  }

  const raw = await runRelicJson(config, ["tail", session.transcriptRef, "-n", String(limit)]);
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { file?: unknown }).file !== "string" ||
    !Array.isArray((raw as { turns?: unknown }).turns)
  ) {
    failRelic("bad_output", "relic tail output missing file/turns");
  }
  const output = raw as RelicTailCommandOutput;
  return output.turns.map((turn) => turnToExcerpt(turn, output.file));
}
