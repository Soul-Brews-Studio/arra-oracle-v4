import { failRelic } from "./relic.errors";
import { runRelicJson } from "./relic.runRelicJson";
import type { RelicAdapterConfig, RelicTailCommandOutput, RelicTailTurn } from "./relic.types";
import type { ReadOptions, SourceExcerpt } from "./session-source.types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function turnToExcerpt(turn: RelicTailTurn, transcriptRef: string): SourceExcerpt {
  return { eventSeq: turn.seq, speaker: turn.role, content: turn.text, sourceTime: turn.ts, transcriptRef };
}

/**
 * `SessionSource.read`: `relic tail <id> -n <limit> --json`. `tail` returns
 * the most recent bounded window of a session's turns (with harness
 * boilerplate already stripped -- relic's own default); it has no
 * seq-offset pagination.
 *
 * `options.from` is therefore refused rather than silently ignored when set
 * (`bad_output` -- there is no lower error code for "this provider cannot do
 * what you asked", and no request ever reaches this adapter directly, so no
 * transport status mapping is needed): a caller asking to resume from a
 * specific point deserves a clear refusal, not a page that quietly starts
 * somewhere else. See the contract's "failure modes" section.
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

  const raw = await runRelicJson(config, ["tail", sessionUuid, "-n", String(limit)]);
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
