# Session links v1 — FROZEN CONTRACT

Status: **FROZEN FOR IMPLEMENTATION**, authorized directly by Nat (product owner) via explicit session goal "finish all task by us", superseding the standing wait-for-separate-dispatch posture for this one slice. Six root decisions below resolve every item in `session-link-decision-matrix.md` and `session-link-acceptance-matrix.md`. Sections are load-bearing; nothing here is advisory.

Parent `Soul-Brews-Studio/arra-oracle-v4#28`. Base: the read-cursor commit landing on `main` at or after `d42ee3e9ef563547ceca128e0d1719bf3386ef56` (exact parent SHA fixed at dispatch time, recorded in the implementation PR).

Physical schema (unchanged, `storage.ts:41`):
`session_links: id utf8 NOT NULL, workspace_name utf8 NOT NULL, from_session_name utf8 NOT NULL, to_session_name utf8 NOT NULL, relation utf8 NOT NULL, evidence_ref utf8 NULL, created_by_peer_name utf8 NULL, created_at timestamp[us] NOT NULL`.

No schema change. `session_links` is authoritative: no accepted snapshot contains it, association reconciliation never writes it, and this slice grants no materializer or scoped-delete authority.

## Decision 1 — Identity / replay: CALLER-STABLE `id`

`id` is the caller-supplied identity, workspace-scoped uniqueness (matching the accepted `appendMessages` `public_id` precedent, not global). Grammar: nanoid21, required. Duplicate `id` within a workspace with an IDENTICAL immutable payload (`from_session_name, to_session_name, relation, evidence_ref, created_by_peer_name`) is exact replay: return the retained row, no clock sample, no write. Duplicate `id` with a DIFFERENT payload is `conflict` at `/id` (returned value, not thrown). Cross-workspace IDs confer no authority.

Rationale: the physical schema has no `operation_id` and adding one is not authorized. Content identity was rejected because it collapses same-edge/different-creator attribution (decision 6) and forces `evidence_ref` canonicalization into the identity path (decision 5), which the accepted `target_key`-free contract for evidence references already rules out. Caller-stable `id` is schema-forced-cheapest and directly reuses the proven `appendMessages` pattern.

## Decision 2 — Endpoint admission: EXISTENCE ONLY, no active-membership requirement

Both `from_session_name` and `to_session_name` must resolve to an EXISTING session in the same workspace (missing session is `invalid_reference` at its own pointer, `/from_session_name` or `/to_session_name` respectively, resolved in that order). Inactive or historical sessions MAY be linked. No membership check on the creating peer, no requirement that a peer named in `created_by_peer_name` currently be a member of either session.

Rationale: session links are annotations about a relationship between sessions, not new conversational content — they follow the read-cursor precedent (historical access permitted) rather than `appendMessages`' active-membership rule, explicitly and by name, per decision-matrix item 2's own instruction not to inherit either policy implicitly.

## Decision 3 — Read shape: keyset ordered by `id` ONLY, both directions as two independent cursors

`orderedProjection` accepts exactly one ordering column and `created_at` is not unique (one clock sample per serialized turn can be shared by concurrent creates). Reads therefore order by `id` ascending — a deterministic, total, but NOT chronological order. This is stated explicitly as a known limitation, not silently accepted as time order.

`listSessionLinks(workspace_name, session_name, direction, cursor, limit)` where `direction` is exactly `"from"` or `"to"` (never "both" in one call): a caller wanting both directions issues two paginated reads, one per direction, each with its own cursor. Limit+1 lookahead validates for a duplicate id straddling the page edge (integrity_failure root, same pattern as `listMessages`/`scanDependents`). Page bound 100 rows, response bound 16 MiB total wire JSON including cursor.

## Decision 4 — Cycle policy: PRESERVED, not weakened; `related_to` explicitly does not enforce

`continues` and `forked_from` are DIRECTED relations for which a stored cycle is `integrity_failure` at root (bounded reverse-walk visited-set of 1024, 1025th `limit_exceeded` root — same bound as reply chains and revision ancestry). A REQUEST that would create an immediate self-link (`from_session_name === to_session_name` for these two relations) is `invalid_request` at `/to_session_name`. `related_to` is symmetric and participates in NEITHER cycle detection nor the self-link refusal (a session may legitimately be "related to" itself is refused too, but for a different reason — see below) — no traversal, no bound, no walk.

Explicit narrower rule: self-link (`from_session_name === to_session_name`) is `invalid_request` at `/to_session_name` for ALL THREE relations, unconditionally — this is a distinct, simpler rule than cycle detection and applies before it.

`SESSION_RELATIONS = ["continues", "forked_from", "related_to"] as const`.

## Decision 5 — Evidence-ref identity: NOT part of identity; stored as-is, explicit null only

Because identity is caller-stable `id` (decision 1), `evidence_ref` carries NO identity role. It is validated through the accepted target codec exactly as association's link targets are (same `TARGET_KEYS`/`targetOp` shapes, no invented `target_key` column — none exists on `session_links`), stored as its canonical JSON text, and compared field-for-field on replay (decision 1's "identical immutable payload" check). Explicit `null` means no evidence attached; omission is a grammar error (`missing_field`). No dereference, no capture-truth claim — annotation only, exactly as `evidence_ref`'s existing description states.

## Decision 6 — Creator attribution: stored fact, not identity, not a conflict input

`created_by_peer_name` is a NULLABLE stored fact, playing no role in identity or conflict. A "same edge, different creator" case is simply a DISTINCT row under a distinct caller-supplied `id` — this service provides no cross-row content deduplication. If the product wants "only one edge of relation R between sessions A and B", that is a READ-side or application-side concern, explicitly out of scope for this write path. Same `id`, different `created_by_peer_name` value, is a changed-payload conflict per decision 1 (peer name is part of the compared immutable payload).

## Grammar

```
createSessionLink {id:N, workspace_name:W, from_session_name:S, to_session_name:S,
                    relation:enum(SESSION_RELATIONS), evidence_ref:TargetJson|null,
                    created_by_peer_name:S|null}
listSessionLinks {workspace_name:W, session_name:S, direction:"from"|"to",
                   cursor:N|null, limit:1..100}
```

Result: `createSessionLink` → `{outcome:"created"|"already_satisfied", row}` or `{outcome:"conflict", row}` (returned value, never thrown, never poisons). `listSessionLinks` → `{rows:[...], next_cursor:N|null}`.

Errors: reuse governed `ContractError`/`arra-error/v1` for grammar; `PublicationError`/`arra-publication-error/v1` codes `invalid_reference`, `invalid_request`, `integrity_failure`, `recovery_required`, `limit_exceeded` for persistence/reference/state. `not_found` excluded; absence reads as an empty page or `invalid_reference`, never `not_found`.

## Boundaries reused unchanged

Same owner registry, serial queue, attempted-write/poison, one-shot close as context/evidence. Context boundary hook names (`before_write`, `after_write`, `after_readback`) reused; one triple per actual mutation, none for replay/conflict/read. `updateWhere`/`append` adapter capabilities reused; no new adapter method. Runtime export count unchanged (this slice adds methods to the existing context reader/writer, exactly as read cursors did — from whatever the post-read-cursor count is, +0 factories).

## Ownership (core only, this dispatch)

Neo, serialized core: `app/server/src/publication/service.ts` (context read/write method additions), new `app/server/src/publication/session-link.ts` (pure grammar/codec), new `app/server/test/session-link-service.test.ts`, new `app/server/test/helpers/session-link-fixture.ts`, new `app/server/test/fixtures/session-link-v1/core/**`, `app/migrate-py/tests/test_revision_v1.py` exact four IsolationTests insertions (session-link.ts immediately after read-cursor.ts in both tuples/patterns, independent flagged sample immediately after the read-cursor sample).

Ownership/recovery/precision lanes are explicitly OUT of this dispatch — not delivered by this pass. Disclosed limit, not silently omitted: full independent-lane coverage (queue exclusion, poison-both-directions, kill-after-write recovery, Int64 boundary sweep) is NOT claimed for this slice at the time of first commit.

## Amendment 2026-09-26 (overnight R7 (exposure part) + R8 (HTTP/MCP part))

`createSessionLink` and `listSessionLinks` were reachable from no transport: `knowledge/registry.ts` deliberately excluded the session-link kernel from `KNOWLEDGE_METHODS`, so `POST /api/knowledge/:bank/createSessionLink` and `.../listSessionLinks` answered 404, and no `kb_createSessionLink`/`kb_listSessionLinks` tool existed for MCP (measured in `.tmp/understand/issue-28/`, `.tmp/understand/issue-31/repro.ts`). `docs/overnight/DECISIONS.md` R7 rules that code no client can call is not done for #28, and R8 keeps the full HTTP+MCP+CLI contract for #31 rather than narrowing it.

Both methods are now registry entries — `listSessionLinks` at `content:read`, `createSessionLink` at `content:write` — with `scopePath: []`, since `workspace_name` sits at the request root in this kernel's own grammar (`parseCreateSessionLink`/`parseListSessionLinks` above), not inside a nested envelope like `publishRevision`'s `content`. HTTP, the `kb_<method>` MCP tool, `tools/list` filtering and the tool→action grant map are all derived from that one registry entry, per the recipe `knowledge/registry.ts`'s own header describes — no second list was touched to expose these two methods. No grammar, validation, cycle-check or replay semantic in this document changed: this amendment is transport reachability only.

Proof: `app/server/test/knowledge-expose13-registry.test.ts` (registry shape, no dataset), `app/server/test/knowledge-expose13-transport.test.ts` (HTTP 404→200 and `kb_createSessionLink`/`kb_listSessionLinks` on `tools/list`, against a fake bundle calling this file's own real parsers), and `app/server/test/knowledge-expose13-live.test.ts` (`createSessionLink` → `listSessionLinks` round-tripped over both HTTP and MCP against a real writer-gated target-19 dataset, plus a same-payload MCP replay landing `already_satisfied`, proving both transports dispatch to the identical registry entry against the identical dataset).

## Amendment 2026-09-26 (overnight R7 (#28 part), Unit B)

Decision 4's cycle walk queried only the relation named on the PROPOSED edge (`relation = rel`). An independent re-verification (`.tmp/understand/analysis-28.json` run2) measured that this let a caller build a two-node loop by mixing relations: with `sess-b --continues--> sess-a` already stored, a request for `sess-a --forked_from--> sess-b` queried `relation = 'forked_from'` while walking, never saw the stored `continues` edge, and returned `"created"` (`oob_cross_relation_cycle: returned created`). `docs/overnight/DECISIONS.md` R7 rules on this for the `#28` part: "Mixed `continues`/`forked_from` cycles are refused across both link kinds (amendment to `session-link-v1.md` Decision 4)."

**Amended rule**: the cycle walk in `service.assertSessionLinkAcyclic.ts` follows `relation IN ('continues', 'forked_from')` at every step, regardless of which of the two directed relations the PROPOSED edge itself names. A loop closed through EITHER relation, or any mix of the two, is refused exactly as a same-relation loop already was:
- Reaching the proposed edge's own `from_session_name` (the immediate child) while walking from `to_session_name` is `invalid_request` at `/to_session_name` — unchanged, still a caller fault, checked first.
- Reaching an already-on-path node deeper in the walk is `integrity_failure` at ROOT — unchanged.
- The bound is unchanged: 1024 distinct finished sessions, or any single node with more than 1024 COMBINED `continues` + `forked_from` out-edges, is `limit_exceeded` at ROOT. This is the same `MAX_CYCLE_VISITED` constant, not a wider one, applied to the union query instead of a single-relation query.
- A legal diamond that reconverges through two DIFFERENT directed relations (e.g. `X --continues--> Y --continues--> W` and `X --forked_from--> Z --forked_from--> W`) is still accepted: the gray/black distinction is unaffected by which relation each edge carries, only by adjacency.

`related_to` is untouched by this amendment: it is still checked first (`if (rel === "related_to") return;`) and never enters the walk, unioned relation set or not — no traversal, no bound, no cycle policy, exactly as the base decision above states.

No schema change, no grammar change, no change to Decision 1–3, 5 or 6. This is a narrower cycle-detection query, not a new rule.

Proof: `app/server/test/session-link-service.test.ts` — "a mixed continues/forked_from loop is refused at the request that closes it" (red before this amendment's code change, green after), "a legal diamond across continues AND forked_from stays accepted", and "related_to stays exempt from the cycle walk even facing a directed loop".
