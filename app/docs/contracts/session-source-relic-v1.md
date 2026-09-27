# Session-source Relic adapter v1 — read-only

Status: **ACCEPTED ISOLATED IMPLEMENTATION**. Dispatched under `docs/overnight/DECISIONS.md`
R7's `#28` part, Unit D of `.tmp/understand/analysis-28.json`. This is a NEW module and a
NEW contract, not an amendment: no earlier document named a Relic adapter's shape.

DESIGN.md's "Message capture and Relic adapter boundary" and SPEC.md section 14.6 describe
the target: a pluggable, external, **read-only** `SessionSource` — "v4 is a client. A
session index is an external service behind one interface, and v4 ships with no
implementation of it beyond a reader for the index that already exists." This document is
that reader, for the one provider actually available on this machine: **Relic**
(`agents-relic`, CLI at `/Users/beta/.bun/bin/relic` — not shipped in this repo, not a new
dependency of it).

No schema change. No transport route. No live wiring into any request-serving code path —
see section 5 for exactly what that means and why.

**2026-09-26, fix round**: an independent adversarial review found this adapter was not
actually read-only against a real relic install (missing `--no-index` on `session`, `tail`
resolving a bare id through the same import path, no `RELIC_NO_TRACE`), that `get()` could
return an unrelated session or a subagent transcript, and that the isolation test proved
absence rather than the real spawned argv. Sections 2, 5, 7 and 8 are corrected below; the
code (`relic.getSession.ts`, `relic.readSession.ts`, `relic.runRelicJson.ts`,
`relic.findSessions.ts`) and tests were fixed to match, failing-first.

---

## 1. What this adapter is for

Citing a past Claude Code / Codex session as evidence — "this conclusion came from what was
said in session X, event N" — needs two things this repo did not have before this dispatch:

1. A way to **resolve** a Relic session or a specific event in it: its stable identity, and
   (for an event) a digest that changes if and only if the cited content changes.
2. A way to **carry** that resolved identity as a normal, already-shipped evidence target —
   `relic_session` or `relic_event` (`contracts/evidence-v1.ts` `TARGET_KEYS`, present in
   this repo since before this dispatch) — on a `createTrace` hit or a `createSessionLink`
   `evidence_ref`, both of which are live on HTTP and MCP (R7's Unit A / `#31` expose-13).

This module is (1). It is a **provider implementation** of the `SessionSource` interface
DESIGN.md/SPEC.md already named, backed by the `relic` CLI's own JSON output — never a new
kernel, never a new write path, never a new transport route.

## 2. What is read

Three, and only three, `relic` subcommands, each with `--json` always appended by this
adapter (`relic.runRelicJson.ts`'s `ALLOWED_SUBCOMMANDS` — a closed allowlist checked BEFORE
`spawn`, not documentation only), and EVERY spawn carries `RELIC_NO_TRACE=1` in its
environment, regardless of subcommand (`relic.runRelicJson.ts`):

| Command | Used for | Measured shape (2026-09-26, real `relic` on this machine) |
|---|---|---|
| `relic session <id> --no-index --json` | `SessionSource.get` | `{query, matchedBy, stats, sessions:[{session_uuid, file_path, repo, source, tier, title?, started_at, ended_at, ...}], neighbours}` |
| `relic search <query> --json --limit N` | `SessionSource.find` | `{query, hits:[{session_uuid, file_path, repo, source, seq, role, ts, text, ...}]}`, BM25-ranked |
| `relic tail <file_path> -n N --json` | `SessionSource.read` | `{file, title, turns:[{seq, role, ts, text}]}` — most-recent bounded window, harness turns already stripped by `relic`'s own default |

`relic index`, `relic prune` and `relic embed` — the only subcommands that ever write —
are never invoked; they are not in the allowlist, and no code path in this module accepts a
caller-chosen subcommand string. Three narrower isolation properties hold beyond the
allowlist, each closing a specific way a "read-only" allowlisted subcommand can still write
or misidentify (measured directly against `agents-relic/src/cli.ts` and `src/query.ts`, an
earlier version of this adapter got each of these wrong — see §8):

1. **`session` always carries `--no-index`.** Without it, relic's own `resolveSession`
   imports a matching on-disk file into the user's REAL index on a cache miss — exactly the
   case for a real, recently started, not-yet-indexed session. `--no-index` skips that
   fallback; relic still answers from whatever is already indexed, so an unindexed session
   is correctly reported as not found, never silently imported.
2. **`read()` never passes a bare id to `tail`.** `cmdTail` resolves a bare id (no `/`)
   through the SAME import-on-miss path `session` uses — it passes `{noIndex:true}` as a
   THIRD argument to `resolveSession`, whose two-parameter signature silently drops it, so no
   flag suppresses the import. A target CONTAINING `/` is read directly as a file path with
   no index lookup at all. `relic.readSession.ts` therefore resolves the file path via
   `SessionSource.get`'s `--no-index` lookup FIRST, then tails that path.
3. **`RELIC_NO_TRACE=1` on every spawn.** `search`'s `cmdSearch` appends one line to
   `<data-root>/trace.jsonl` per call unless this env var is set; `relic.runRelicJson.ts`
   sets it unconditionally rather than only for `search`, so the property holds regardless of
   which allowlisted subcommand is added here later.

**Argument safety.** relic's flag parser does not honor `--` as an end-of-options marker
(`agents-relic/src/flags.ts`): a value starting with `-` is parsed as a FLAG, not positional
text. Measured probe: `flags(["search","--data-root=/tmp/elsewhere","--limit","100","--json"])`
⇒ `{f:{"data-root":"/tmp/elsewhere",...}, pos:["search"]}` — the query vanished and the index
root was redirected. `relic.assertNotFlagLike.ts` refuses any caller-supplied `sessionId` or
`query` starting with `-` before it is ever spawned (`bad_output`), and an empty `sessionId`
or `query` is refused/short-circuited rather than spawned at all — relic's own prefix query
(`session_uuid LIKE '${q}%'`) matches every row when `q` is empty, and `tail ""` resolves to
"the previous session in the process's cwd", neither of which is "no result".

**Field mapping** (`relic.rowToSessionRef.ts`, `relic.findSessions.ts`, `relic.readSession.ts`):

- `sourceBank` — the FIRST path segment of the row's `repo` field. Measured: `repo` is always
  `<bank>/<repo_key>` (e.g. `"peer-projects/github.com/Soul-Brews-Studio/odin-oracle"`,
  `"projects/github.com/nat-build-with-oracle/…"`), and `relic banks --json` lists exactly
  the bank names that first segment is drawn from ("A bank is one whole source root").
  Extracted once, in `relic.bankFromRepo.ts`, shared by the session and search-hit paths.
- `provider` — the row's `source` field verbatim (`"claude-live"`, `"claude-peer"`,
  `"claude-archive"`, `"codex"`, …). This is the field `relic` itself uses to say which
  harness/tier produced the transcript; nothing here renames or buckets it further.
- `sessionUuid` — the row's `session_uuid`, but ONLY for `get()` when it exactly equals the
  requested id AND the row's `tier` is `"session"` — see §7's "absence is `null`" note.
- `transcriptRef` — the row's `file_path` (an absolute path to the source `.jsonl`, not a
  network locator — never fetched, never dereferenced by this module).
- `eventSeq` / `speaker` / `content` / `sourceTime` — a search hit's or tail turn's
  `seq` / `role` / `text` / `ts`, type-checked before use and unchanged otherwise.

`content` is retrieved, **untrusted** text (`session-source.types.ts`'s `SourceExcerpt`
doc comment): a caller must carry or display it, never interpret it as an instruction —
the same posture `trace-v1.md` section 6 states for a trace hit's `excerpt`.

## 3. The capture-digest canonical payload

DESIGN.md: *"Hash a versioned canonical source payload (speaker/content/source time),
excluding ingestion time."*

`relic.captureDigest.ts` implements exactly that:

```
RELIC_CAPTURE_DOMAIN = "arra-relic-capture/v1\n"
capture_digest = sha256hex(RELIC_CAPTURE_DOMAIN || JCS({speaker, content, source_time}))
```

— the same domain-prefixed-canonical-JSON pattern `contracts/evidence-v1.ts`'s own
`target_key` already uses (`TARGET_DOMAIN`), with a DIFFERENT domain string because this
hashes a narrower, event-specific payload, not a whole normalized target.

Deliberately **excluded**: `eventSeq` and `transcriptRef` (identity, not content — two
excerpts with the same speaker/content/source-time get the SAME digest regardless of their
position, proven in `relic-session-source.test.ts`), and any local "when this server fetched
it" timestamp (ingestion time — this adapter has no such column and computes no such value).
A changed `speaker`, `content`, or `source_time` each change the digest; nothing else does.

## 4. How evidence pins a relic session or event

```text
 1. operator or script runs `relic search` / `relic session` / `relic tail`
    (directly, or via SessionSource.find/get/read imported from this module)
                              |
                              v
 2. relic.buildRelicEventTarget(session, excerpt)     -- ONE specific event
    relic.buildRelicSessionTarget(session)            -- a WHOLE session
                              |
              runs the SAME normalizeTarget("relic_event"|"relic_session", …)
              the server applies at write time -- a malformed excerpt fails
              HERE, at build time, with the identical ContractError
                              |
                              v
 3. the resulting plain object is handed, AS-IS, to the EXISTING,
    already-transport-exposed API:
      createTrace       { hits: [{ kind: "relic_event", target: <built object>, ref, ... }] }
      createSessionLink { evidence_ref: { target_kind: "relic_session"|"relic_event",
                                           target: <built object> } }
                              |
                              v
 4. the server's OWN copy of normalizeTarget re-validates and stores it --
    this adapter is a BUILDER of a request body, not a second write path
```

Nothing in step 3/4 is new: `createTrace`'s hit codec and `createSessionLink`'s
`evidence_ref` codec already accept any of the eleven `TARGET_KINDS`, `relic_session` and
`relic_event` included, and already validate `capture_digest` as 64 lowercase hex
(`requireSha256Hex`). This dispatch adds the ability to CONSTRUCT a correct one from a real
Relic lookup; it does not touch `service.createTrace.ts` or `service.createSessionLink.ts`.

## 5. Why this stays an internal service, not a `content:read` registry method

This dispatch's own slice brief (the per-agent task text for R7's `#28` part, not itself
committed to this repo) leaves this decision explicitly open: "Expose what is needed as
content:read registry methods only if the contract calls for server-side lookup … else keep
it an internal service used by createTrace/evidence pinning — decide, document, justify."
`docs/overnight/DECISIONS.md` R7's own `#28` bullets settle the adjacent questions (mixed-
relation cycles, caller-asserted attribution, the CLI-subprocess mechanism) but do not
themselves use the words "Unit D" or discuss server-side exposure — that framing is
`.tmp/understand/analysis-28.json`'s Unit D fix-plan item 5 and the slice brief above.
**Decision: internal service. Not exposed on HTTP, MCP, or the CLI, in this dispatch.**

Reasons, checked against the current authorities before writing this down:

1. **Relic is not workspace-scoped, and arra-oracle's entire security model is.** Every
   `content:read`/`content:write` grant in `arra-auth/v1` is scoped to ONE `workspace_name`
   (`auth/policy.types.ts`). Relic's index spans the WHOLE machine: every repo, every org,
   every Claude Code and Codex session Nat has ever run, sharded by bank, never by arra
   workspace. A generic `findSourceSessions`/`readSourceEvents` registry method would let
   ANY `content:read` holder of ANY single arra workspace read session content from every
   OTHER workspace's world, and every unrelated repo on the machine besides — a severe
   cross-tenant confidentiality breach, not a narrow leak. There is no existing policy
   dimension ("which relic banks/repos this grant may query") to scope it with, and
   inventing one is a fresh auth-model review, out of R7's #28 part.
2. **Pinning does not need the SERVER to run the subprocess.** Once a human or a trusted
   script has identified the exact session/event to cite (by running `relic search` /
   `session` / `tail` directly, or this module's own `find`/`get`/`read` from a local
   script), the only thing that needs to reach the arra server is the ALREADY-VALID,
   ALREADY-DIGESTED target object — and `createTrace`/`createSessionLink` already accept
   that over HTTP and MCP (section 4). No new network-callable "ask the server to go query
   Relic for me" capability is needed to satisfy AC1/AC2's "pinned relic session/event
   evidence" requirement.
3. **This keeps the adapter's blast radius equal to its actual trust boundary.** The
   `relic` binary and its index live entirely outside arra-oracle's dataset roots and
   writer-gate model (`ARRA_DATA_DIR` / `ARRA_KNOWLEDGE_DATASET_ROOT`); admitting request
   traffic into it would be the FIRST place in this codebase where an HTTP/MCP caller's
   request reaches a subprocess outside that model at all.

If a future need genuinely requires server-side Relic lookup (e.g. a UI that resolves a
session name to a title without a human running `relic` themselves), that is a fresh
dispatch with its own scoped-authorization design — not a default this contract reaches for.

## 6. Configuration — trusted, never request-selectable

```
ARRA_SESSION_SOURCE=relic        # anything else, or unset: "not configured"
ARRA_RELIC_BIN=/absolute/path    # REQUIRED when ARRA_SESSION_SOURCE=relic -- no
                                  # baked-in default (a specific operator's home
                                  # directory path must never ship as every other
                                  # checkout's fallback)
ARRA_RELIC_TIMEOUT_MS=10000      # optional, default 10s
ARRA_RELIC_MAX_OUTPUT_BYTES=8388608   # optional, default 8 MiB
```

`resolveSessionSourceConfig` (`relic.resolveSessionSourceConfig.ts`) is pure and reads these once, at
composition time, exactly like every other `ARRA_*` variable in `composition.ts`. It is not
consulted per-request, and nothing in this module accepts a caller-supplied bin path,
timeout, or byte cap — those would turn a trusted local tool invocation into a
request-controlled subprocess, which analysis-28.json's own Unit D risk list (item 6) calls
out as exactly the thing to avoid.

**"Not configured" is an explicit, first-class state** (SPEC.md section 14.6: "Unset ⇒ the
surface reports 'session source: not configured' … does not fail, and does not silently
return nothing"), represented by `SessionSourceStatus`'s `{configured:false, reason}` rather
than a thrown error or a null the caller must guess the meaning of.

**Composition-root wiring is intentionally NOT part of this dispatch.** `composition.ts` is
the eventual place a future consumer (e.g. a `createTrace`/evidence-pinning flow that wants
to auto-resolve a cited session) would call `resolveSessionSourceConfig(env)` and thread the
result through — but nothing in this repo consumes a `SessionSource` yet (section 5), so
wiring it into the shared composition root now would add unexercised plumbing to a file
several other overnight slices are concurrently editing, for no caller. This module is
complete and independently tested (section 8) without that wire; a future dispatch that adds
a real consumer does the wiring then, against a concrete calling convention.

## 7. Failure modes

Every failure is a typed `RelicAdapterError` (`relic.errors.ts`) — never a bare thrown
string, never a hang. This is an INTERNAL error type, not the governed `arra-error/v1` or
`arra-publication-error/v1` envelope: nothing here crosses a transport (section 5), so there
is no wire shape to keep stable.

| Code | When |
|---|---|
| `unavailable` | the binary could not be spawned at all (missing, not executable, `ENOENT`, …) |
| `timeout` | `RelicAdapterConfig.timeoutMs` elapsed; the child is SIGKILLed by its own handle, never left running |
| `exit_nonzero` | the process exited with a nonzero code |
| `output_too_large` | stdout exceeded `maxOutputBytes`; the child is killed immediately rather than drained to completion |
| `bad_output` | stdout was not the JSON shape the calling function expects for that subcommand, OR a hit/row/turn was missing a field this adapter needs (§2 field mapping), OR a caller-chosen subcommand fell outside the allowlist, OR a `sessionId`/`query` looked like a relic flag (§2 "argument safety"), OR `read()`'s `options.from` was set (see below) |
| `not_found` | `read()`'s internal `get()`-based resolve step found no exact-uuid, tier:`"session"` row for the given `sessionUuid` |

**`read()`'s `from` parameter is refused when set, never silently ignored.** `relic tail`
has no seq-offset pagination — it returns the most-recent bounded window only. A caller
asking to resume reading from a specific point deserves a clear refusal (`bad_output`), not
a page that silently starts somewhere else. A future provider (or a future `relic` flag)
that supports real pagination can lift this restriction without changing the interface.

**Absence is `null`, never thrown, from `get()`** — an unknown id, OR a row relic did return
that does not exactly identify the requested session, returns `null`, matching this
codebase's existing convention (`trace-v1.md` section 6: "`getTrace` returns the literal row
or `null`"). "Does not exactly identify" covers two measured relic behaviors an evidence-
pinning caller cannot tolerate: relic's `session` command falls back to matching the text as
a NAME (title or opening message) when no id/prefix hits, so a returned row's `session_uuid`
can be a completely different session than the one asked for; and an id/prefix hit returns
every row sharing that `session_uuid`, including subagent transcripts, in no guaranteed
order. `getSession` therefore accepts only a row whose OWN `session_uuid` equals the request
AND whose `tier` is exactly `"session"` — never `sessions[0]`. `read()` has no `null` state of
its own (its contract is an array or a throw), so the same resolution failure is `not_found`
there rather than a silently empty transcript.

## 8. Isolation from the user's real index

An earlier version of this section claimed isolation on the strength of one test alone (a
scratch directory the adapter was never even pointed at stays untouched) and called that "a
direct proof, not just an absence of a real path in test code" — a fair mutation-testing
critique showed that claim was itself a tautology: mutating `runRelicJson` to write an
arbitrary file elsewhere did not fail that test, because the test never inspected what the
adapter actually sent to the child process. This section now states what is ACTUALLY proven,
by what mechanism, none of it against the real relic index:

- **No write subcommand is ever reachable** — the allowlist in `relic.runRelicJson.ts`
  (`search`, `session`, `sessions`, `tail`) is checked before every `spawn`, so a bug in a
  future caller cannot turn a read into an `index`/`prune`/`embed` call.
- **The binary path is always the caller's own injected configuration** — never resolved
  from `$PATH`, never read from a request. A test's fake script and the real
  `/Users/beta/.bun/bin/relic` are indistinguishable to every function in this module except
  by which path is configured. Every test in `relic-session-source.test.ts` injects the fake
  (`test/fixtures/relic-v1/fake-relic.ts`) and never sets `ARRA_RELIC_BIN` to the real path.
- **The fake REFUSES to run a call that would be unsafe against real relic** — it exits
  nonzero if `RELIC_NO_TRACE=1` is missing from its environment, if a `session` call lacks
  `--no-index`, or if a `tail` call's target is a bare id rather than a file path (§2's three
  isolation properties). A regression in any of them turns EVERY test that exercises the
  normal `find`/`get`/`read` path into a loud, specific failure (`exit_nonzero`), not a silent
  pass — this is what actually replaces the withdrawn "direct proof" claim.
- **The exact argv and `RELIC_NO_TRACE` value delivered to the child is recorded and
  asserted on directly** — an opt-in side channel (`RELIC_FAKE_RECORD`, read by
  `recordCalls()` in the test file) has the fake append one JSON line per invocation. The
  "read-only against relic" describe block asserts the literal argv for `get`/`find`/`read`
  (`--no-index` present, the tail target containing `/` and equal to the resolved
  `transcript_ref`, `--limit`/`-n` values after clamping) and that `RELIC_NO_TRACE` is `"1"`
  — a mutation that drops any of these is a direct, immediate assertion failure, not an
  absence of one.
- **Scenario selection stays MAGIC-argv, not environment-based**, so parallel test files
  cannot interfere with each other through process-global state: `__not_found__`,
  `__bad_json__`, `__exit_nonzero__`, `__timeout__`, `__big__`, plus the identity-mismatch/
  subagent/malformed-output scenarios in §7's field-mapping tests. `RELIC_FAKE_RECORD` is the
  one exception, and it is set and restored around a single `recordCalls()` call, never left
  set across tests.
- **A scratch-directory check remains, as a coarse sanity check, not the load-bearing
  proof**: one test creates a directory standing in for "the user's real relic index", calls
  `find`/`get`/`read` against the fake binary, and asserts the directory's one marker file is
  byte-identical and its mtime unchanged afterward, with no new files created.

## 9. What this dispatch does NOT claim

- No transport route (HTTP, MCP or CLI) exposes any of this — section 5.
- No live wiring into `composition.ts`, `service.createTrace.ts`, or
  `service.createSessionLink.ts` — sections 4 and 6. The pure builders exist and are tested
  in isolation; nothing calls them yet.
- No real pagination in `read()` — section 7.
- No controlled dereference of `transcriptRef` or any other locator (AGENTS rule 7:
  references are passive; also `#28`'s Unit E, separately scoped and not part of this
  dispatch).
- No caching, no freshness/staleness signal beyond what `relic`'s own JSON already reports
  (e.g. `relic pending` exists for "indexed vs pending" questions but is not called here).

## 10. Proof

`app/server/test/relic-session-source.test.ts` — config resolution (all four
configured/not-configured branches), `find`/`get`/`read` against the fake binary including
result-shape and dedup checks, every failure code in section 7 (each independently
triggered, including `not_found` and the identity/tier checks), the isolation proof (section
8: the argv/env recording, the fake's own refusal checks, and the scratch-directory check),
argument-injection refusal for a flag-like `sessionId`/`query` (section 2), bounded-excerpt
clamping for both `find`'s overfetch and `read`'s `-n` (measured against the real `--limit`/
`-n` argument, not just the returned array length), malformed-hit/turn rejection (section 2's
field mapping), capture-digest determinism/distinctness (section 3), and both target builders
producing a codec-valid, already-canonical `relic_event`/`relic_session` object that
`targetOp` accepts unchanged.

## Amendment 2026-09-26 (post-merge #28 TODO (cwd-only foreign visitor) + discussions #21/#36)

**Change.** This amendment adds one invariant and its tests. No adapter code changes.
**A shared working directory never decides grouping, lineage, ownership or import.** relic's
`repo` is `<bank>/<cwd-derived repo_key>`. The adapter keeps only `<bank>` as `sourceBank`, and
`SessionRef` has no repo, cwd or worktree key. `find` groups on `session_uuid` only, so two
sessions that share a directory stay two sessions, with two distinct `relic_session`
identities. The v4 grammars that could record lineage or ownership (`createSessionLink`, and
`registerSession` including `h_metadata`) are closed objects, and they refuse a `cwd` key at
`/cwd` and at `/h_metadata/cwd`.

**What the directory still reaches.** The directory is not erased. `SessionRef.transcriptRef`
is relic's `file_path` (`relic.findSessions.ts` `hitToRef`, `relic.rowToSessionRef.ts`), and
the parent of that path is the cwd-derived project folder, for example
`/Users/nat/.claude/projects/-opt-Code-github-com-example-neo-oracle/s-owner.jsonl`.
`buildRelicEventTarget` copies it into `relic_event.transcript_ref`, and that is an identity
key in the #23 target codec: `contracts/evidence-v1.ts` lists it in `TARGET_KEYS.relic_event`,
and `DISPLAY_ONLY` exempts only `relic_session.title_snapshot`. So the project folder is a
passive locator, and it is part of `relic_event` identity. Moving only the folder changes the
`target_key`. Two sessions in one folder still get distinct event identities, because their
`session_uuid` and file name differ. Nothing in `app/server/src` groups on `transcriptRef` or
`transcript_ref` today, but the codec does not stop a later consumer from grouping on the
folder inside it. Doing so would be a new cwd rule and would need its own ruling.

**Reason.** The #28 TODO says to "exclude cwd-only foreign visitors". The defining text is a
prohibition. Discussion #20 §10 says: "A visitor session sharing cwd does not become part of
the worktree's original lineage." Discussion #36 (DESIGN.md:392, :415) says: "A cwd move does
not transfer session ownership. External references must not silently import a foreign session
or bridge workspaces." It also says: "shared cwd does not justify importing Ansible." And #28's
Boundaries rule out "automatic session ownership inference". So the visitor is excluded by never
letting the directory decide anything. It is not excluded by a classifier, because relic's rows
carry no ownership signal except cwd-derived ones.

**Pinned by** `app/server/test/relic-foreign-visitor.test.ts` (10 tests) and the
`__shared_cwd__` scenario in `test/fixtures/relic-v1/fake-relic.ts`. The pins cover only
these things: `find`'s grouping; `SessionRef`'s key set on both the `find` path and the `get`
path; `sourceBank`; `relic_session` identity, checked against both spellings of the directory
(relic's repo key and the dash-encoded folder); the `cwd` refusals; and the locator facts in
the paragraph above. They do not prove that no later consumer groups on `transcript_ref`. The
invariant already held, so the tests passed on first run. Their teeth are shown by mutants,
each measured against this file:

| Mutant | Fails |
|---|---|
| M1: `findSessions` dedups on `hit.repo` | 4 |
| M2: `bankFromRepo` keeps the whole `repo` | 2 (the `find` and the `get` key-set tests) |
| M3b: `createSessionLink` accepts `cwd` as an optional key | 1 (only the refusal test) |
| M7: `rowToSessionRef` adds a `repo` key (the `get` path) | 1 |
| M8: `transcript_ref` made display-only for `relic_event` | 1 (the identity-input test) |
| M9: `transcriptRef` stripped to the file name | 2 |

**Not decided here.** Two things are left open: an active visitor label at this boundary, and
restricting `getContext` chain expansion to `continues`/`forked_from`. Both are NEEDS-NAT;
`docs/overnight/FOREIGN-VISITOR.md` §4 gives the quotes and the readings. The adapter's shape
still follows `docs/overnight/DECISIONS.md` R7 (#28): a relic CLI subprocess behind an
interface, a fake in tests, and the real index never touched.

## Amendment 2026-09-26 (post-merge Nat style: one exported function per file, named after the file (ratchet: app/server/test/one-function-per-file.test.ts))

The path cited above, `relic.errors.ts`, moved. The style-shrink slice
(`docs/overnight/DECISIONS.md`; ratchet `app/server/test/one-function-per-file.test.ts`
MISNAMED_ALLOWLIST) renamed it to `relic.failRelic.ts` by a pure `git mv` -- `RelicAdapterError`,
`RELIC_ADAPTER_ERROR_CODES`, `failRelic` and their behavior are byte-identical; only the
filename changed, to satisfy the ratchet's "one exported function per file, named after the
file" rule. This section is not rewritten in place; read `relic.errors.ts` above as
`relic.failRelic.ts`.
