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
| AGENTS.md:124 | "Relic is a read-only source; namespace and pin evidence; cwd/adjacency does not prove ownership" |

"Visitor" appears only in #20. It does not appear in SPEC.md, DESIGN.md, #21, #36, #101, the
issue comments, or the relic source, measured with `rg -i visitor`. "The relic source" here and
below means the installed `relic`: package `agents-relic`, which `which relic` resolves to the
checkout `Soul-Brews-Studio/agent-relic-v2.1/src/cli.ts`. All relic line numbers cite that checkout.

## 2. What the text settles: a prohibition, not a detector

> **Correction (fix round, 2026-09-27).** The first version of this section and of the contract
> amendment said "The directory is dropped" and "A shared working directory is never an input".
> Both claims are false. Written as tests, both fail on this base. `find()` returns
> `transcriptRef` `/Users/nat/.claude/projects/-opt-Code-github-com-example-neo-oracle/s-owner.jsonl`,
> and the `relic_event` `key_json` contains the same folder. The corrected claim is below. The
> directory never *decides* grouping, lineage, ownership or import. It is still *carried*, as a
> passive locator inside `transcriptRef` and `relic_event.transcript_ref`.

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
- **The directory never decides grouping.** relic's `repo` is `<bank>/<cwd-derived repo_key>`
  (relic `query.ts:1857`: "real cwd-derived repo key"). The adapter keeps only `<bank>`
  (`relic.bankFromRepo.ts`), and `SessionRef` has no repo, cwd or worktree key. `find` groups on
  `session_uuid` only, and `relic_session` identity is `(source_bank, provider, session_uuid)`.
- **But the directory is carried, as a passive locator.** `SessionRef.transcriptRef` is relic's
  `file_path` (`relic.findSessions.ts:25`, `relic.rowToSessionRef.ts:29`), and the parent of
  that path is the cwd-derived project folder (`-opt-Code-github-com-…`). `buildRelicEventTarget`
  copies it into `relic_event.transcript_ref`. That is an identity key in the #23 codec:
  `contracts/evidence-v1.ts:51` lists it, and `DISPLAY_ONLY` (`:60-61`) exempts only
  `relic_session.title_snapshot`. So the folder is part of `relic_event` identity. Moving only
  the folder changes the `target_key`. Owner and visitor events still have distinct keys, because
  their `session_uuid` and file name differ. Nothing in `app/server/src` groups on
  `transcriptRef` or `transcript_ref` today. Measured with `rg`: the only uses are the adapter's
  own `relic tail <transcriptRef>` and the copy into the target, and no code does a prefix or
  partial match on a stored `target_json`. But the codec does not stop a later consumer from
  grouping on that folder. Doing so would be a new cwd rule and would need its own ruling.
- **No grammar accepts a directory.** `createSessionLink` and `registerSession` are closed
  objects. `registerSession.h_metadata` is closed to `{title}`.
- **relic's own cwd defaults are unreachable.** `relic tail` with no target resolves "the
  session before this one" in the process cwd (`cli.ts:1306-1308`). The adapter refuses empty
  and `-`-prefixed ids and always tails a resolved file path. `search`, `session` and
  `sessions` scope by cwd only under an explicit `--cwd` flag (`cli.ts:63-64`), which the
  adapter never passes.

## 3. What this slice built

This slice changed no product code, because there was no defect to fix. It adds tests that pin
the prohibition where a future change could break it. They were not failing first, since the
behaviour already held. The mutants below show that the tests have teeth. The fix round's only
failing-first red is the §2 correction: the old claim, written as a test, fails.

`app/server/test/relic-foreign-visitor.test.ts` (10 tests) and one new fake scenario,
`__shared_cwd__`, in `test/fixtures/relic-v1/fake-relic.ts`. The scenario has an owner and a
visitor that ran in one directory, so relic gives them the same `repo` and project folder.

**Scope of the pins.** They cover `find`'s grouping, `SessionRef`'s key set on both the `find`
and the `get` path, `sourceBank`, `relic_session` identity (checked against both the repo-key
and the dash-encoded folder spelling), the `cwd` refusals, and the locator facts in §2. They do
not prove that no later consumer groups on `transcript_ref`.

| Test | Mutants that turn it red (measured, fix round) |
|---|---|
| owner and visitor stay two sessions, never merged on the cwd key | M1 |
| `find()`: `SessionRef` key set, `sourceBank` = `projects`, and `relic_session` `key_json` contains neither the repo key nor the folder | M1, M2 |
| `get()`: the session-row path has the same key set and bank-only `sourceBank` | M2, M7 |
| control: a link without `cwd` parses | none (control) |
| `createSessionLink` refuses `cwd` at `/cwd` | M3b |
| control: a session without `cwd` parses | none (control) |
| `registerSession` refuses `cwd` at `/cwd` and at `/h_metadata/cwd` | closed-object grammar (§2). In effect this is the closed-object rule applied to one key name |
| `transcriptRef` is relic's `file_path`, and owner and visitor share one folder | M1, M9 |
| `relic_event.transcript_ref` carries the folder and is an identity input | M8, M9 |
| owner and visitor events at the same seq, words and second stay two targets | M1 |

Mutants: M1 `findSessions` dedups on `hit.repo` (4 fail). M2 `bankFromRepo` keeps the whole
`repo` (2 fail). M3b `createSessionLink` accepts `cwd` as an *optional* key (1 fail, only the
refusal test; this isolates the pin, where the first round's M3, adding `cwd` to the required
`CREATE_KEYS`, also broke the control). M7 `rowToSessionRef` adds a `repo` key (1 fail here, 1
in `relic-session-source.test.ts`). M8 `transcript_ref` made display-only for `relic_event`
(1 fail). M9 `transcriptRef` stripped to the file name (2 fail).

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
relations, `related_to` included (`service.getContext.ts:55-68`).
- *Would build:* restrict `getContext` expansion to `DIRECTED_SESSION_RELATIONS`, plus an
  amendment to chat-v1.md.
- *Why not here:* this is analysis-28 Unit C ("A related_to link is not expanded, unless the
  decision says it should be"). It changes #32 chat behaviour, and no ruling covers it
  (DECISIONS.md R3/R4 cover membership and coverage, not relation choice). It also is not a
  *cwd* rule.

**The question for Nat:** is the #28 TODO satisfied by the prohibition in §2, pinned in §3? Or
do you want B (a visitor label, which first needs a non-cwd ownership signal that relic does
not provide) or C (lineage-only chain expansion)?

## 5. Not done, and without an owner

AC-MATRIX item 8 (`session-foreign-visitor-and-literal-evidence`) also bundles the literal #28 AC1
end-to-end test: one conclusion cites 2 traces and 2 sessions, and reverse lookup returns all of
them. This slice did not build it. It is outside this slice's brief, and no other slice owns it.

> **Sweep correction (proof-sweep, 2026-09-27).** "no other slice owns it" is no longer true. The
> ac1-literal slice built it after this file was written (commit `3b51a00`, merged in PR #127):
> `app/server/test/association-ac1-literal.test.ts`, 1 test. Measured on `594df54` with
> `cd app/server && bun test test/association-ac1-literal.test.ts`: `1 pass / 0 fail`, 81 expect() calls.
