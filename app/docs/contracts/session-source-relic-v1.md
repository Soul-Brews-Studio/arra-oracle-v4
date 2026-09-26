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
`spawn`, not documentation only):

| Command | Used for | Measured shape (2026-09-26, real `relic` on this machine) |
|---|---|---|
| `relic session <id\|prefix> --json` | `SessionSource.get` | `{query, matchedBy, stats, sessions:[{session_uuid, file_path, repo, source, title?, started_at, ended_at, ...}], neighbours}` |
| `relic search <query> --json --limit N` | `SessionSource.find` | `{query, hits:[{session_uuid, file_path, repo, source, seq, role, ts, text, ...}]}`, BM25-ranked |
| `relic tail <id> -n N --json` | `SessionSource.read` | `{file, title, turns:[{seq, role, ts, text}]}` — most-recent bounded window, harness turns already stripped by `relic`'s own default |

`relic index`, `relic prune` and `relic embed` — the only subcommands that ever write —
are never invoked; they are not in the allowlist, and no code path in this module accepts a
caller-chosen subcommand string.

**Field mapping** (`relic.rowToSessionRef.ts`, `relic.findSessions.ts`, `relic.readSession.ts`):

- `sourceBank` — the FIRST path segment of the row's `repo` field. Measured: `repo` is always
  `<bank>/<repo_key>` (e.g. `"peer-projects/github.com/Soul-Brews-Studio/odin-oracle"`,
  `"projects/github.com/nat-build-with-oracle/…"`), and `relic banks --json` lists exactly
  the bank names that first segment is drawn from ("A bank is one whole source root").
- `provider` — the row's `source` field verbatim (`"claude-live"`, `"claude-peer"`,
  `"claude-archive"`, `"codex"`, …). This is the field `relic` itself uses to say which
  harness/tier produced the transcript; nothing here renames or buckets it further.
- `sessionUuid` — the row's `session_uuid`.
- `transcriptRef` — the row's `file_path` (an absolute path to the source `.jsonl`, not a
  network locator — never fetched, never dereferenced by this module).
- `eventSeq` / `speaker` / `content` / `sourceTime` — a search hit's or tail turn's
  `seq` / `role` / `text` / `ts`, unchanged.

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

`docs/overnight/DECISIONS.md` R7's Unit D leaves this decision explicitly open ("Expose …
only if the contract calls for server-side lookup … else keep it an internal service").
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

`resolveSessionSourceConfig` (`relic.resolveConfig.ts`) is pure and reads these once, at
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
| `bad_output` | stdout was not the JSON shape the calling function expects for that subcommand, OR a caller-chosen subcommand fell outside the allowlist, OR `read()`'s `options.from` was set (see below) |

**`read()`'s `from` parameter is refused when set, never silently ignored.** `relic tail`
has no seq-offset pagination — it returns the most-recent bounded window only. A caller
asking to resume reading from a specific point deserves a clear refusal (`bad_output`), not
a page that silently starts somewhere else. A future provider (or a future `relic` flag)
that supports real pagination can lift this restriction without changing the interface.

**Absence is `null`, never thrown** — `get()` on an unknown id returns `null`, matching this
codebase's existing convention (`trace-v1.md` section 6: "`getTrace` returns the literal row
or `null`").

## 8. Isolation from the user's real index

- **No write subcommand is ever reachable** — the allowlist in `relic.runRelicJson.ts`
  (`search`, `session`, `sessions`, `tail`) is checked before every `spawn`, so a bug in a
  future caller cannot turn a read into an `index`/`prune`/`embed` call.
- **The binary path is always the caller's own injected configuration** — never resolved
  from `$PATH`, never read from a request. A test's fake script and the real
  `/Users/beta/.bun/bin/relic` are indistinguishable to every function in this module except
  by which path is configured.
- **Every test in `relic-session-source.test.ts` injects a fake binary**
  (`test/fixtures/relic-v1/fake-relic.ts`) and never sets `ARRA_RELIC_BIN` to the real path.
  The fake's scenarios are selected by MAGIC ids/queries in argv (`__not_found__`,
  `__bad_json__`, `__exit_nonzero__`, `__timeout__`, `__big__`), never by a shared
  environment variable, so parallel test files cannot interfere with each other through
  process-global state.
- **A direct proof, not just an absence of a real path in test code**: one test creates a
  scratch directory standing in for "the user's real relic index", calls `find`/`get`/`read`
  against the fake binary, and asserts the scratch directory's one marker file is
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
triggered), the isolation proof (section 8), capture-digest determinism/distinctness
(section 3), and both target builders producing a codec-valid, already-canonical
`relic_event`/`relic_session` object that `targetOp` accepts unchanged.
