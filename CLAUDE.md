# arra-oracle-v4

**Read [`AGENTS.md`](AGENTS.md) first — it is the canonical guide for this repo.**

Current operating rules live in AGENTS.md; the complete target design lives in DESIGN.md.
This file holds only Claude Code session guidance, not a second design authority.

---

## Orientation

- Read `AGENTS.md` and `DESIGN.md` for current Python/LanceDB/TS direction. `SPEC.md` preserves historical rationale, including superseded architecture.
- Active code exists in `app/`; inspect `git status`/HEAD rather than assuming a branch or PR state. The 19-table target is built and enforced by the TypeScript runtime, and it serves 57 knowledge methods on HTTP, MCP and CLI, but it is not the default migration: `python -m arra_migrate` still creates the 15-table set, and `target-19-manifest.json` still says `proposed-not-active`. AGENTS.md "Current implementation" has the measured detail.
- `ψ/` is a symlink to the shared neo-oracle vault. **Never `git add` anything under it.**

## Before you edit `SPEC.md`

1. Read the current AGENTS/DESIGN direction first; SPEC §3/§4 are historical rationale, not current storage authority.
2. Check AGENTS.md's "Chosen direction" table and current issue contract gates; separate historical decisions from later superseding evidence.
3. Bump the version on every substantive edit — CalVer `v{yy}.{m}.{d}-alpha.{HMM}`,
   Asia/Bangkok, `HMM = hour*100 + minute`. `**Version**:` and `**Date**:` move together.

## Editing this file safely

`SPEC.md` is large and heavily cross-referenced. Two failure modes have already happened
here:

- **Blanket `sed`/replace-all across the file corrupted prose** that legitimately contained
  the old term (a rename turned the sentence *"no column is named `bank_id`"* into
  nonsense). Anchor edits on unique surrounding context, never a bare term.
- **Section numbering landed out of order** when a new subsection was inserted by string
  match. After inserting, `grep -n '^#### '` to confirm the sequence.

For large restructures, write the new section to a heredoc file first and splice it, rather
than patching a patch.

## Useful skills in this repo

| Skill | Why here |
|---|---|
| `/oracle-prism` | design review of a spec section. Found five real defects in §3/§14 in one pass, including a table asserted tenant-safe with no schema written anywhere |
| `/forward`, `/rrr` | handoffs and retros land in the shared vault, not this repo |
| `/calver --apply` | version bump |

## Fleet rules that apply here

- `rg`, never `grep -r` / `find /` / `bfs /`. Resolve `ghq root` first; cache `ghq list`.
- Browser work via `/ego-browser` only.
- Never `git push --force`, never `git commit --amend`, never merge a PR without human
  approval, never push to `main`, never commit secrets.
- Use `git -C <path>`, not `cd`. Temp files in `.tmp/` only.
- Attribute commits to the actual AI author; never use a Claude identity for another assistant.

*Written by an Oracle — AI speaking as itself (Rule 6).*
