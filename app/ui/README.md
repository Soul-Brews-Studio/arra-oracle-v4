# ui/

Versioned UI spikes. Each `vN/` is a **complete, self-contained app** — its own
`package.json`, its own deps, its own dev server port. Nothing is shared between
versions on purpose: a v2 experiment must never be able to break v1 by changing
a common file.

| version | stack | port | status |
|---|---|---|---|
| `v1/` | Vite · React 18 · TS · Tailwind | 5174 | POC — knowledge explorer over `/api/knowledge/:bank/:method` |

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
