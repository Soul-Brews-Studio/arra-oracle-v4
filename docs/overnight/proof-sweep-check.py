"""Re-check the proof sweep's fix-round citation corrections (#22, 2026-09-27).

Each row says: the doc must cite `cite`, must no longer carry the stale `stale` text (for
in-place fixes; a frozen contract keeps its stale text and gains an amendment instead), and
the cited source line(s) must contain `expect`. Source lines are read from the checkout, so a
later edit that moves a cited line turns this red, which is the point: doc-contradicts-code
is a defect (docs/overnight/DECISIONS.md, PROOF.md rule).

Usage, from the repo root:
    python3 docs/overnight/proof-sweep-check.py            # docs from the working tree
    python3 docs/overnight/proof-sweep-check.py <rev>      # docs as committed at <rev>
Exit 0 when every row holds; 1 otherwise. Source files are always read from the working tree.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
S = "app/server/src/"
T = "app/server/test/"

# (doc, cite as written in the doc, stale text that must be gone or None, source, lines, expect)
ROWS = [
    ("AGENTS.md", "`knowledge/transport.state.ts:12`", "`knowledge/transport.ts:67`",
     S + "knowledge/transport.state.ts", (12, 12), r"MAX_KNOWLEDGE_REQUEST_BYTES = 1024 \* 1024"),
    ("AGENTS.md", "`mcp/tools.ts:18,181,201`", "`mcp/tools.ts:16,171,191`",
     S + "mcp/tools.ts", (181, 181), r"export const KNOWLEDGE_TOOLS"),
    ("AGENTS.md", "`mcp/tools.ts:18,181,201`", None,
     S + "mcp/tools.ts", (18, 18), r"export const MEMORY_TOOLS = \["),
    ("AGENTS.md", "`mcp/tools.ts:18,181,201`", None,
     S + "mcp/tools.ts", (201, 201), r"TOOLS = \[\.\.\.MEMORY_TOOLS, \.\.\.KNOWLEDGE_TOOLS\]"),
    ("AGENTS.md", "`composition.composeV3Compat.ts:7-8`", "`composition.ts:242-244`",
     S + "composition.composeV3Compat.ts", (7, 8), r'ARRA_MCP_V3_COMPAT === "1"'),
    ("AGENTS.md", "`app.createApp.ts:175`", "`app.ts:157`",
     S + "app.createApp.ts", (175, 175), r'headers\.get\("x-arra-peer"\)'),
    ("AGENTS.md", "`app.createApp.ts:155-156`", "`app.ts:137-140`",
     S + "app.createApp.ts", (155, 156), r"onRequest[\s\S]*checkHostAndOrigin"),
    ("AGENTS.md", "`index.startup.ts:59-61`", "`index.ts:92-96`",
     S + "index.startup.ts", (59, 61), r'app\.listen\([\s\S]*hostname: "127\.0\.0\.1"'),
    ("AGENTS.md", "`app.createApp.ts:259`", "`app.ts:243`",
     S + "app.createApp.ts", (259, 259), r'\.get\("/health"'),
    ("AGENTS.md", "`app.createApp.ts:468-497`", "`app.ts:429-458`",
     S + "app.createApp.ts", (468, 497), r"options\.assets === undefined[\s\S]*staticPlugin"),
    ("AGENTS.md", "`app.createApp.ts:93-99`", "`app.ts:79-85`",
     S + "app.createApp.ts", (93, 99), r"const bankParam"),
    ("AGENTS.md", "`:269-274`", "`:253-259`",
     S + "app.createApp.ts", (269, 274), r'\.get\("/api/health"[\s\S]*errorResponse\(400\)'),
    ("AGENTS.md", "`mcp-correctness.test.ts:470-472`", "`mcp-correctness.test.ts:435-437`",
     T + "mcp-correctness.test.ts", (470, 472), r"unscoped HTTP reads fail closed[\s\S]*toBe\(400\)"),
    ("app/README.md", "`app.createApp.ts:155-156`", "`app.ts:137-140`",
     S + "app.createApp.ts", (155, 156), r"onRequest[\s\S]*checkHostAndOrigin"),
    ("app/README.md", "`app.createApp.ts:468-497`", "`app.ts:429-458`",
     S + "app.createApp.ts", (468, 497), r"options\.assets === undefined[\s\S]*staticPlugin"),
    ("app/README.md", "`app.createApp.ts:93-99`", "`app.ts:79-85`",
     S + "app.createApp.ts", (93, 99), r"const bankParam"),
    ("app/README.md", "`:269-274`", "`:253-259`",
     S + "app.createApp.ts", (269, 274), r'\.get\("/api/health"[\s\S]*errorResponse\(400\)'),
    ("app/README.md", "`test/mcp-correctness.test.ts:470-472`", "`test/mcp-correctness.test.ts:435-437`",
     T + "mcp-correctness.test.ts", (470, 472), r"unscoped HTTP reads fail closed[\s\S]*toBe\(400\)"),
    ("app/README.md", "`composition.composeV3Compat.ts:7-8`", "`composition.ts:242-244`",
     S + "composition.composeV3Compat.ts", (7, 8), r'ARRA_MCP_V3_COMPAT === "1"'),
    ("app/README.md", "`mcp/legacy-v3/tools/oracle_search_chain.ts:81`", None,
     S + "mcp/legacy-v3/tools/oracle_search_chain.ts", (81, 81), r"coverage, aggregated OR across hops"),
    ("docs/overnight/AC-MATRIX.md", "now `:244`", None,
     "app/migrate-py/tests/test_copy_migration.py", (244, 244), r'meta\["attribution_unresolved"\]'),
    ("docs/overnight/AC-MATRIX.md", "the R4 amendment is `:242-314`", None,
     "app/docs/contracts/chat-v1.md", (242, 242), r"^## Amendment 2026-09-26 \(overnight R4\)"),
    ("docs/overnight/AC-MATRIX.md", "the R4 amendment is `:242-314`", None,
     "app/docs/contracts/chat-v1.md", (315, 315), r"^## Amendment 2026-09-26 \(overnight R9"),
    # Frozen contracts keep the stale text; the appended amendment carries the correction.
    ("app/docs/contracts/context-ingestion-v1.md", "`DESIGN.md:371`", None,
     "DESIGN.md", (371, 371), r"display title = optional metadata, not another mutable identity"),
    ("app/docs/contracts/search-chunk-v1.md", "`DESIGN.md:1125`", None,
     "DESIGN.md", (1125, 1125), r"stale vectors never present superseded content as current truth"),
    ("app/docs/contracts/taxonomy-write-v1.md", "`mcp/legacy-v3/publish.ts:110-118`", None,
     S + "mcp/legacy-v3/publish.ts", (110, 118), r"input\.reconcile === true[\s\S]*reconcileRevisionAssociations"),
    ("app/docs/contracts/taxonomy-write-v1.md", "`tools/oracle_trace_distill.ts:88`", None,
     S + "mcp/legacy-v3/tools/oracle_trace_distill.ts", (88, 88), r"reconcile: true"),
    ("docs/SCHEMA-BUILT.md", "`api/listSearchChunks.ts:19`", None,
     "app/ui/v2/src/api/listSearchChunks.ts", (19, 19), r"export function listSearchChunks\("),
    ("docs/SCHEMA-BUILT.md", "`api/getSearchFreshness.ts:21`", None,
     "app/ui/v2/src/api/getSearchFreshness.ts", (21, 21), r"export function getSearchFreshness\("),
    ("docs/SCHEMA-BUILT.md", "`state/searchFreshnessView.ts:104`", None,
     "app/ui/v2/src/state/searchFreshnessView.ts", (104, 104), r"`embedPendingChunks will retry"),
    # PROOF-SWEEP.md's own "File:line (doc)" locators into AGENTS.md (drift reports them, row 39).
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:21", None, "AGENTS.md", (21, 22), r"mcp_calls  \}  written on every admitted MCP call"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:39", None, "AGENTS.md", (39, 39), r"^- \*\*Storage\.\*\*[\s\S]*mcp_calls"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:41", None, "AGENTS.md", (41, 41), r"capped at 1 MiB"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:45", None, "AGENTS.md", (45, 45), r"^- \*\*MCP tools: 66\*\*"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:46", None, "AGENTS.md", (46, 46), r"^- \*\*v3-compatible MCP adapter\*\*"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:54", None, "AGENTS.md", (54, 54), r"X-Arra-Peer"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:86", None, "AGENTS.md", (86, 86), r"`Host`/`Origin` gate"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:88", None, "AGENTS.md", (88, 88), r"`/health` and the static UI"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:99", None, "AGENTS.md", (99, 99), r"malformed `\?bank` is refused"),
    ("docs/overnight/PROOF-SWEEP.md", "AGENTS.md:109", None, "AGENTS.md", (109, 109), r"^- \*\*UI\.\*\*"),
    # Line 461 is the last line (462 is the empty string after the final newline): 461 lines.
    ("app/docs/contracts/revision-evidence-v1.md", "is 461 lines", None,
     "app/migrate-py/src/arra_migrate/revision_v1.py", (461, 462), r"\S.*\n\Z"),
]


def doc_text(doc: str, rev: str | None) -> str:
    if rev is None:
        return (ROOT / doc).read_text()
    return subprocess.run(["git", "-C", str(ROOT), "show", f"{rev}:{doc}"],
                          capture_output=True, text=True, check=True).stdout


def main() -> int:
    rev = sys.argv[1] if len(sys.argv) > 1 else None
    failures = 0
    for doc, cite, stale, src, (a, b), expect in ROWS:
        text = doc_text(doc, rev)
        lines = (ROOT / src).read_text().split("\n")[a - 1:b]
        problems = []
        if cite not in text:
            problems.append(f"doc does not cite {cite}")
        if stale is not None and stale in text:
            problems.append(f"doc still carries stale {stale}")
        if not re.search(expect, "\n".join(lines), re.M):
            problems.append(f"{src}:{a}-{b} does not match /{expect}/")
        status = "FAIL" if problems else "ok  "
        failures += bool(problems)
        print(f"{status} {doc} {cite} -> {src}:{a}-{b}" + ("" if not problems else "  [" + "; ".join(problems) + "]"))
    print(f"{len(ROWS) - failures} ok / {failures} fail of {len(ROWS)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
