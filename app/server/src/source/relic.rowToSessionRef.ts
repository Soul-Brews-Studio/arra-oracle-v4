import { failRelic } from "./relic.errors";
import type { RelicSessionRow } from "./relic.types";
import type { SessionRef } from "./session-source.types";

/**
 * `repo` on every relic row this adapter reads is `<bank>/<repo_key>`
 * (measured: `"peer-projects/github.com/Soul-Brews-Studio/odin-oracle"`,
 * `"projects/github.com/nat-build-with-oracle/…"`; `relic banks --json`
 * lists the bank names this first segment is drawn from). The bank is the
 * source root Relic sharded the row under -- see the contract's "what is
 * read" section.
 */
function bankFromRepo(repo: string): string {
  const slash = repo.indexOf("/");
  return slash === -1 ? repo : repo.slice(0, slash);
}

/**
 * One `RelicSessionRow` (from `relic session`/`relic sessions`) to this
 * adapter's own `SessionRef`. `source` (e.g. `"claude-live"`, `"codex"`,
 * `"claude-archive"`) is used verbatim as `provider` -- it is the field
 * relic itself uses to say which harness/tier produced the transcript.
 */
export function rowToSessionRef(row: RelicSessionRow): SessionRef {
  if (typeof row.session_uuid !== "string" || row.session_uuid === "") {
    failRelic("bad_output", "relic session row missing session_uuid");
  }
  if (typeof row.file_path !== "string" || row.file_path === "") {
    failRelic("bad_output", "relic session row missing file_path");
  }
  if (typeof row.repo !== "string" || row.repo === "") {
    failRelic("bad_output", "relic session row missing repo");
  }
  if (typeof row.source !== "string" || row.source === "") {
    failRelic("bad_output", "relic session row missing source");
  }
  return {
    sourceBank: bankFromRepo(row.repo),
    provider: row.source,
    sessionUuid: row.session_uuid,
    transcriptRef: row.file_path,
    title: row.title ?? row.description ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
  };
}
