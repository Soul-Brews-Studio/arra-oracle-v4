# ui/

Versioned UI spikes. Each `vN/` is a **complete, self-contained app** — its own
`package.json`, its own deps, its own dev server port. Nothing is shared between
versions on purpose: a v2 experiment must never be able to break v1 by changing
a common file.

| version | stack | port | status |
|---|---|---|---|
| `v1/` | Vite · React 18 · TS · Tailwind | 5174 | POC — knowledge explorer over `/api/knowledge/:bank/:method` |
| `v2/` | Vite · React 18 · TS · Tailwind | 5175 | POC — memory browser, Honcho-shaped: peers → sessions → transcript → dialectic |

## What v2 is, and the constraint that shaped it

v1 is a method picker: pick one of the 26 registry methods, edit a JSON body,
read the envelope back. v2 is a **memory browser** modelled on Honcho's
dashboard — workspace, then peers and sessions, then a session transcript, then
a dialectic panel that asks a question *as a peer, about a session* and shows
the evidence the answer was allowed to use.

One server property shapes the entire layout: **there is no enumeration
endpoint.** The registry has `getPeer` and `getSession` — lookups by exact
name — and no `listPeers` or `listSessions`. A Honcho dashboard opens on a
populated sidebar; this one cannot, because the server genuinely cannot answer
"which peers exist".

So v2's rails are a **local bookmark list** in `localStorage`, and every entry
is re-verified against the server and labelled `live` / `missing` / `unknown`.
Bookmarks that the server does not have stay visible and marked rather than
being quietly dropped — a name you saved that no longer resolves is worth
seeing. The roster is never treated as truth.

Two consequences worth knowing before using it:

- A peer must `joinSession` before `getContext` returns anything for them.
  Membership is enforced per item, so a non-member sees an empty context rather
  than an error.
- Membership is also the read boundary on `listMessages`/`getMessage` (#87,
  `docs/overnight/DECISIONS.md` R3). The v2 transcript pane reads with no
  `requester_peer_name`, which is the operator view and needs `audit:read` on
  the bank; the dev-stack token has it. A `content:read`-only token gets 403
  there and must name a peer that is a current member of the session.
- `answerChat` falls back to a refusal envelope when no chat model is wired
  server-side, which is the default for a local server. The dialectic panel
  says so rather than letting you debug a working system.

## Running one

```bash
cd ui/v1 && bun install && bun run dev
```

Each version proxies `/api` to the Bun server on `:3000` (see its
`vite.config.ts`), so the UI talks to live endpoints rather than fixtures.

## Adding a version

Copy the previous version, bump the port in `vite.config.ts`, and add a row
above. Do NOT factor shared code up into `ui/` — the isolation is the feature.
If two versions genuinely need the same thing, the honest move is to promote it
into the server or a real package, not a loose shared folder here.

## A rebuild needs a hard reload

`bun run build` emits a new hashed asset, but `index.html` is served from the
API server's static assets and the browser caches it. A normal reload then
loads yesterday's JavaScript against today's HTML, which presents as "my change
did nothing" — it cost two debugging detours before it was recognised. Force a
reload (`location.reload(true)`, or a hard refresh) after every build.
