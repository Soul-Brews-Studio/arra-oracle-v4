# #28 "exclude cwd-only foreign visitors": what the text defines, what was built, what needs Nat

**Date**: 2026-09-27 · slice `foreign-visitor` · branch `v4/on-foreign-visitor` (base `f444bf5`)
**Written by**: Claude Opus 5.5 (AI), overnight slice agent.

The AC audit (AC-MATRIX.md §#28, open question 6) found no code and no test for the #28 TODO
*"preserve source-bank/provider/session UUID provenance and exclude cwd-only foreign visitors."*
This file quotes every defining line I found and says which part is settled and which is not.

## 1. The defining text, verbatim

The phrase itself appears only in the #28 TODO. The idea comes from the Relic journey in
discussion #20, which #21 simplifies ("it does not erase it") and #36 supersedes where they conflict.

| Source | Text |
|---|---|
| #28 TODO | "Implement explicit continues/forked_from/related_to session links; preserve source-bank/provider/session UUID provenance and exclude cwd-only foreign visitors." |
| #28 Boundaries | "No full Honcho deriver/dreamer, generic entity/binding framework, or **automatic session ownership inference**." |
| #20 §1 | "For v4 itself the scoped chain remains `53a8949c → 89094970 → 2762e4e7`. The visitor `2bb9b553` belongs to the ansible-oracle transcript corpus and is excluded from v4 design lineage." |
| #20 §10 acceptance example | "**A visitor session sharing cwd does not become part of the worktree's original lineage.**" |
| #21, #36, DESIGN.md:66-67 | "Foreign session 2bb9b553 is NOT part of this worktree's design chain. Relic source bank != v4 workspace/bank." |
| #36, DESIGN.md:91 | "Foreign Ansible remains excluded." |
| #21, #36, DESIGN.md:392 | "Temporal proximity suggests a possible continuation; it does not prove one. A cwd move does not transfer session ownership. External references must not silently import a foreign session or bridge workspaces." |
| #36, DESIGN.md:415 | "Cite Relic by default; explicit selected imports preserve provenance … Source banks are not authorization scopes; shared cwd does not justify importing Ansible." |
| #36, DESIGN.md:881 | "A chain filter is an explicit expansion over permitted linked sessions, not a default widening to foreign sessions or all workspaces." |
| #36, DESIGN.md:1138 | "explicit scope + bounded chain expansion cannot admit foreign sessions" |
| #36 comment 2 (namespaces) | "Provider/account/session components may inform explicit configuration, but must not be guessed from cwd or apparent conversation adjacency. … A Relic bank is not automatically a v4 workspace." |
| #36 comment 1 (codecs) | "`session_uuid` is an opaque provider identity, not guessed from cwd" |
| AGENTS.md:123 | "Relic is a read-only source; namespace and pin evidence; cwd/adjacency does not prove ownership" |

"Visitor" appears only in #20. It does not appear in SPEC.md, DESIGN.md, #21, #36, #101, the
issue comments, or the relic source (`agents-relic/src`, measured with `rg -i visitor`).

## 2. What the text settles: a prohibition, not a detector

Every line above is negative. A session that shares only a working directory with the
worktree must **not** become part of its lineage, be imported into its workspace, be merged
with its sessions, or have its identity guessed from that directory. In the one worked example
(`2bb9b553`), a human read the transcript and decided it belonged to the ansible-oracle corpus.
No rule in the text lets software make that decision, and the #28 Boundaries forbid
"automatic session ownership inference".

Measured on this base, the prohibition already holds by construction:

- **No import path.** Nothing turns a Relic session into a v4 session or a v4 link. The Relic
  adapter is internal and has no consumer (session-source-relic-v1.md §5-§6).
- **No inferred edge.** A session link is created only by an explicit `createSessionLink`
  call. No code creates one from time, adjacency or directory.
- **The directory is dropped.** relic's `repo` is `<bank>/<cwd-derived repo_key>`
  (agents-relic `query.ts:1857`: "real cwd-derived repo key"). The adapter keeps only `<bank>`
  (`relic.bankFromRepo.ts`), and `SessionRef` has no repo, cwd or worktree field.
- **No grammar accepts a directory.** `createSessionLink` and `registerSession` are closed
  objects. `registerSession.h_metadata` is closed to `{title}`.
- **relic's own cwd defaults are unreachable.** `relic tail` with no target resolves "the
  session before this one" in the process cwd (`cli.ts:1306-1308`). The adapter refuses empty
  and `-`-prefixed ids and always tails a resolved file path. `search`, `session` and
  `sessions` scope by cwd only under an explicit `--cwd` flag (`cli.ts:59-61`), which the
  adapter never passes.

## 3. What this slice built

This slice changed no product code, because there was no defect to fix. It adds tests that pin
the prohibition where a future change could break it. They were not failing first, since the
behaviour already held; the evidence that they have teeth is the three mutants below.

`app/server/test/relic-foreign-visitor.test.ts` (6 tests) and one new fake scenario,
`__shared_cwd__`, in `test/fixtures/relic-v1/fake-relic.ts`. The scenario has an owner and a
visitor that ran in one directory, so relic gives them the same `repo` and project folder.

| Test | Mutant that turns it red (measured) |
|---|---|
| owner and visitor stay two sessions, never merged on the cwd key | M1: `findSessions` dedups on `hit.repo` → 2 fail |
| the cwd-derived repo key is not part of a `SessionRef` or its `relic_session` identity | M2: `bankFromRepo` returns the whole `repo` → 1 fail (`Expected "projects"`, received `"projects/github.com/example/neo-oracle"`) |
| `createSessionLink` refuses `cwd` (pointer `/cwd`) and a control parses | M3: `cwd` added to `CREATE_KEYS` → 2 fail |
| `registerSession` refuses `cwd` at the top level (`/cwd`) and inside `h_metadata` (`/h_metadata/cwd`), and a control parses | — (closed-object grammar, see §2) |

## 4. NEEDS-NAT: an active "exclude" is not defined

The TODO's verb "exclude" can also be read as something the system *does* to a visitor. Two
readings of that kind are plausible. The text supports neither, so neither was built.

**Reading B: classify and drop or label visitors at the Relic boundary.** When a workspace
reads Relic sessions, flag sessions that match only on cwd as `foreign_visitor`.
- *Would build:* a workspace-to-repo mapping, plus a per-session "whose corpus" test in
  `relic.findSessions.ts`/`relic.getSession.ts`, plus a label on `SessionRef`.
- *Why not:* relic's rows carry no owner or oracle field. The only fields that tie a session
  to a place are `repo` and the project folder, and both come from cwd. Classifying on them
  uses the very signal the text says "does not prove ownership". The text also says "Relic
  source bank != v4 workspace/bank", so no workspace-to-repo mapping exists to classify
  against. And the #28 Boundaries forbid automatic ownership inference.

**Reading C: keep visitors out of chain expansion.** #36 has a verification buddy as a
"related … NOT a continuation edge", and parallel readers in the same worktree as "peers …
NOT successor sessions". So a visitor may carry at most `related_to`, and "lineage" would
be `continues`/`forked_from` only. `getContext` today expands one hop over **all**
relations, `related_to` included (`service.getContext.ts:34-47`).
- *Would build:* restrict `getContext` expansion to `DIRECTED_SESSION_RELATIONS`, plus an
  amendment to chat-v1.md.
- *Why not here:* this is analysis-28 Unit C ("A related_to link is not expanded, unless the
  decision says it should be"). It changes #32 chat behaviour, and no ruling covers it
  (DECISIONS.md R3/R4 cover membership and coverage, not relation choice). It also is not a
  *cwd* rule.

**The question for Nat:** is the #28 TODO satisfied by the prohibition in §2, pinned in §3? Or
do you want B (a visitor label, which first needs a non-cwd ownership signal that relic does
not provide) or C (lineage-only chain expansion)?
