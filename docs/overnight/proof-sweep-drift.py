"""Find `file:line` citations, written on a given day, whose cited lines have since moved (#22).

For every doc that `git log --since=<day>` lists under the proof sweep's scope, `git blame`
keeps only the lines committed (author or committer date, GMT+7) on that day. Each `name.ext:N`
citation on such a line, and each bare `:N` that follows one on the same line, is resolved to a
tracked file by path suffix or unique basename. The cited lines are compared as they stood in
the blame commit (when the doc line was written) and in <rev>. A difference is printed as DRIFT.
It finds drift only: a citation that was already wrong when written compares equal and is not
flagged, so the sweep still opens the cited line by hand (PROOF-SWEEP.md §2).

Usage, from the repo root:  python3 docs/overnight/proof-sweep-drift.py [rev] [day]
Defaults: rev HEAD, day 2026-09-27. Exit 1 when any DRIFT is printed.
"""

import collections
import datetime
import os
import re
import subprocess
import sys

REV = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
DAY = sys.argv[2] if len(sys.argv) > 2 else "2026-09-27"
SCOPE = ["docs", "app/docs/contracts", "AGENTS.md", "DESIGN.md", "app/README.md"]
TZ = datetime.timezone(datetime.timedelta(hours=7))
TOKEN = re.compile(
    r"(?P<file>[A-Za-z0-9_.\-/]+\.(?:tsx|ts|py|md|json|yml|yaml|sh|toml|css|js))"
    r"(?P<spec>(?::\d+(?:-\d+)?)(?:\s*,\s*:?\d+(?:-\d+)?)*)|`:(?P<bare>\d+(?:-\d+)?)"
)


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True).stdout


tracked = git("ls-tree", "-r", "--name-only", REV).split("\n")
by_base = collections.defaultdict(list)
for path in tracked:
    by_base[os.path.basename(path)].append(path)
cache: dict = {}

# Pure `git mv` renames (style-shrink, #22): a citation written under the old name, on a
# line last touched before the rename landed, would otherwise resolve to nothing in the
# REV tree and get silently dropped from `checked` -- coverage loss with no DRIFT warning.
# Map old path -> new path (both directions) so `resolve()` still finds the new file, and
# the historical ("then") read below falls back to the old path at a pre-rename sha.
RENAMED = {
    "app/server/src/app.ts": "app/server/src/app.createApp.ts",
    "app/server/src/auth/loader.ts": "app/server/src/auth/loader.loadPolicy.ts",
    "app/server/src/auth/service.ts": "app/server/src/auth/service.createOperationService.ts",
    "app/server/src/mcp/legacy-v3/chain.stopped.ts": "app/server/src/mcp/legacy-v3/chain.chainStopped.ts",
    "app/server/src/source/relic.errors.ts": "app/server/src/source/relic.failRelic.ts",
    "app/cli/kb.help.ts": "app/cli/kb.kbHelpText.ts",
    "app/cli/kb.readRequestBody.ts": "app/cli/kb.readKbRequestBody.ts",
    "app/ui/v2/src/forum/threads.ts": "app/ui/v2/src/forum/threads.buildThreads.ts",
}
RENAMED_FROM = {new: old for old, new in RENAMED.items()}
for old, new in RENAMED.items():
    by_base.setdefault(os.path.basename(old), []).append(new)


def source(rev: str, path: str):
    if (rev, path) not in cache:
        r = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True)
        cache[(rev, path)] = r.stdout.split("\n") if r.returncode == 0 else None
    return cache[(rev, path)]


def resolve(name: str):
    if "/" in name:
        found = [t for t in tracked if t == name or t.endswith("/" + name)]
        if len(found) == 1:
            return found[0]
        for old, new in RENAMED.items():
            if old == name or old.endswith("/" + name):
                return new
        return None
    found = by_base.get(name, [])
    return found[0] if len(found) == 1 else None


def blamed_lines(doc: str):
    row: dict = {}
    for line in git("blame", "--line-porcelain", REV, "--", doc).split("\n"):
        if re.match(r"^[0-9a-f]{40} \d+ \d+", line):
            row = {"sha": line[:8], "n": int(line.split()[2])}
        elif line.startswith(("author-time ", "committer-time ")):
            row.setdefault("days", set()).add(
                datetime.datetime.fromtimestamp(int(line.split()[1]), TZ).date().isoformat())
        elif line.startswith("\t"):
            yield row, line[1:]


docs = sorted({f for f in git("log", REV, f"--since={DAY} 00:00", "--name-only", "--format=", "--", *SCOPE).split()
               if f.endswith(".md") and git("ls-tree", REV, f).strip()})
# Drift that is deliberately left in place, each with where its correction lives.
KNOWN = {
    ("app/docs/contracts/context-ingestion-v1.md", "DESIGN.md:369"): "frozen; corrected by its PROOF.md-rule amendment",
    ("app/docs/contracts/search-chunk-v1.md", "DESIGN.md:1119"): "frozen; corrected by its §25 amendment",
    ("docs/overnight/UI-PROOF-ui-cite.md", "app/ui/v2/src/components/PublishForm.tsx:50"):
        "historical refutation record of pre-fix code (PROOF-SWEEP.md §2)",
}
# Whole target files whose citations from one doc are pinned line by line in proof-sweep-check.py.
KNOWN_TARGETS = {
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md"):
        "the sweep's own locators; AGENTS.md changed after they were written; pinned in proof-sweep-check.py",
}
checked = drifted = 0
for doc in docs:
    for row, text in blamed_lines(doc):
        if DAY not in row.get("days", ()):
            continue
        current = None
        for m in TOKEN.finditer(text):
            if m.group("file"):
                current = resolve(m.group("file"))
                spec = m.group("spec")
            elif current is not None:
                spec = ":" + m.group("bare")
            else:
                continue
            if current is None:
                continue
            then = source(row["sha"], current)
            if then is None and current in RENAMED_FROM:
                then = source(row["sha"], RENAMED_FROM[current])  # pre-rename sha, pre-rename path
            now = source(REV, current)
            if then is None or now is None:
                continue
            nums = [int(x) for x in re.findall(r"\d+", spec)]
            checked += 1
            moved = [n for n in nums if (then[n - 1] if n <= len(then) else None) != (now[n - 1] if n <= len(now) else None)]
            if moved:
                known = (KNOWN.get((doc, f"{current}{spec}")) or KNOWN.get((doc, f"{os.path.basename(current)}{spec}"))
                         or KNOWN_TARGETS.get((doc, current)))
                drifted += known is None
                label = f"KNOWN ({known})" if known else "DRIFT"
                print(f"{label} {doc}:{row['n']} [{row['sha']}] {current}{spec} lines {moved}")
print(f"{len(docs)} docs, {checked} citations checked, {drifted} drifted (KNOWN lines excluded)")
sys.exit(1 if drifted else 0)
