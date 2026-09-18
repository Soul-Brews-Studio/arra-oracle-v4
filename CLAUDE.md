# arra-oracle-v4

**Read [`AGENTS.md`](AGENTS.md) first — it is the canonical guide for this repo.**

Everything about the design, the closed decisions, the column idiom, and the working rules
lives there. This file holds only what is specific to Claude Code sessions. The spec itself
bans two writable sources for one fact (§14.4); these two files follow the same rule.

---

## Orientation

- **`SPEC.md` is the product.** 2,195 lines, `v26.9.18-alpha.915`. There is **no code in
  this repo yet**, by decision.
- Currently on branch `spec/honcho-core`, **PR #1 open** against `main`.
- `ψ/` is a symlink to the shared neo-oracle vault. **Never `git add` anything under it.**

## Before you edit `SPEC.md`

1. Skim §3 (data model) and §4 (storage) — most questions are already answered there, often
   with a `> Decision (date, Nat):` callout explaining why the obvious alternative lost.
2. Check AGENTS.md's "closed decisions" table. Several were settled after three or four
   rounds of redesign; reopening one without new evidence costs a session.
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
- Attribution on commits: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.

*Written by an Oracle — AI speaking as itself (Rule 6).*
