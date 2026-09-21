# Evidence — what a revision is allowed to point at

Measured 2026-09-21 from `app/server/src/contracts/evidence-v1.ts`. Every kind,
every key, in the exact order the contract traverses them.

This is arra-oracle-v3's inheritance, and the answer to "can a claim carry the
code path, the GitHub URL and the full session id it came from". It can. All
three already exist as contracted target kinds — what does not yet exist is a
UI that shows them and a populated `revision_links` table.

---

## 0 · The shape

A revision carries `link_snapshot_json`: an ordered list of links, each one a
`(relation, target_kind, target)` triple plus capture metadata.

```text
node_revision
  └── link_snapshot_json  [ {relation, target_kind, target, excerpt,
                             content_hash, captured_at, capture_status, note},
                            … ]
                │
                ├── relation ∈ supports | contradicts | derived_from
                │              discusses | corrects | related_to
                │
                └── target_kind ∈ 11 kinds below; `target` is a CLOSED object
                    whose keys are fixed per kind
```

Two properties worth stating before the table:

**`target` is a closed object, not a string.** A link to a line of code is not
a URL someone typed — it is `{repo, commit, path, line_start, line_end}`, and
an unknown key is a refusal. That is what makes an evidence reference
machine-checkable rather than a note.

**Retrieved means CONSIDERED, not SUPPORTS.** The relation is chosen by the
author. Nothing in the system upgrades "this came back in a search" into "this
supports the claim".

---

## 1 · The eleven target kinds

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║  TARGET_KINDS — evidence-v1.ts:37                    key order is contractual ║
╚══════════════════════════════════════════════════════════════════════════════╝

  ── INTERNAL ────────────────────────────────────────────────────────────────
  node_revision   node_id · revision_id
                  one revision of one node. The only way to cite our own
                  knowledge, and it cites a REVISION, never a node — a claim
                  points at the text that was actually there.

  trace           trace_id

  message         session_name · message_public_id
  session         session_name

  ── RELIC (the session corpus) ──────────────────────────────────────────────
  relic_session   source_bank · provider · session_uuid · title_snapshot
  relic_event     source_bank · provider · session_uuid · transcript_ref
                  event_seq · capture_digest

                  THE FULL SESSION PATH, four parts, not one id:
                    source_bank   which corpus root (per machine)
                    provider      claude-live / codex / …
                    session_uuid  the session itself
                    transcript_ref + event_seq  the exact line

                  `capture_digest` pins WHAT WAS READ. A transcript that
                  changes later does not silently rewrite the claim that
                  cited it -- the digest stops matching and says so.

  ── CODE AND GITHUB ─────────────────────────────────────────────────────────
  code            repo · commit · path · line_start · line_end
                  A code citation is pinned to a COMMIT, not a branch. A
                  reference to `main` rots the moment someone pushes; a
                  reference to a commit is still true in a year.

  commit          repo · commit
  issue           repo · number · url
  discussion      repo · number · url · comment_id
  url             url
                  `url` is the escape hatch and the weakest kind: one opaque
                  string, nothing to verify against. Prefer any of the four
                  above it when the target is really a repo, an issue, a
                  discussion or a line of code.
```

---

## 2 · Identity vs display

`TARGET_KEYS` defines the full key set. A second list, `DISPLAY_ONLY`, marks
keys excluded from identity.

That distinction is the interesting part. `target_key` is a sha256 over
`{workspace_name, target_kind, identity}` — so two links to the same code line
collapse to one identity even if one of them carries a different
`title_snapshot`. A display field can change without forking the evidence
graph; an identity field cannot change at all without becoming a different
target.

```text
  target_key = sha256( domain ‖ canonical{ workspace_name,
                                            target_kind,
                                            identity(target) } )
```

`capture_status`, `excerpt`, `content_hash` and `captured_at` live on the LINK,
not the target: they record what this author saw when they cited it, which is
separate from what the target is.

**Missing source? Show unresolved or locator-only — never a fabricated
citation.** That rule is from #36 and this schema is what enforces it: there is
no shape for "a reference I could not resolve but rendered anyway".

---

## 3 · Where this stands today

| piece | state |
|---|---|
| contract (`evidence-v1.ts`) | **built** — 11 kinds, closed key sets, digest identity |
| `revision_links` table | **built** — 12 columns, in the enforced 19 |
| write path | `publishRevision` accepts `link_snapshot_json` |
| projection | `reconcileRevisionAssociations` fills the table, on demand |
| read path | `getRevisionAssociations` (per revision), `scanDependents` (reverse) |
| rows in the dev dataset | **0** |
| UI | **nothing renders it** |

The gap is not the model. The model is more careful than most systems manage —
commit-pinned code references, four-part session paths, capture digests, and a
separation between what a target IS and how it happens to be labelled.

The gap is that nothing writes links yet and nothing shows them. A "supports"
edge from a conclusion to the exact file and line that justifies it is fully
expressible today and has never been used.

---

## 4 · The smallest useful next step

Publish one revision whose `link_snapshot_json` carries three links — a `code`
target with a real repo/commit/path/lines, an `issue` target with its URL, and
a `relic_event` with the full four-part session path — then run
`reconcileRevisionAssociations` and read it back with `getRevisionAssociations`.

That proves the whole chain end to end with one node, and gives the UI
something real to render instead of an empty panel.
