/**
 * `repo` on every relic row this adapter reads is `<bank>/<repo_key>`
 * (measured: `"peer-projects/github.com/Soul-Brews-Studio/odin-oracle"`,
 * `"projects/github.com/nat-build-with-oracle/…"`; `relic banks --json`
 * lists the bank names this first segment is drawn from). The bank is the
 * source root Relic sharded the row under -- see the contract's "what is
 * read" section.
 *
 * ONE copy, shared by `relic.rowToSessionRef.ts` (session/tail rows) and
 * `relic.findSessions.ts` (search hits) -- both used to duplicate this.
 */
export function bankFromRepo(repo: string): string {
  const slash = repo.indexOf("/");
  return slash === -1 ? repo : repo.slice(0, slash);
}
