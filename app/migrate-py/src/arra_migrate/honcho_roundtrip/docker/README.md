# Bringing up the pinned Honcho target (manual, not run by this harness)

> **Executed 2026-09-27 on m5, with Docker Desktop already running (no VM was started).**
> `bash app/just/honcho-live.sh` runs the steps below exactly as written and
> always tears down. The pinned HEAD matched `210b56cf…`, the api was healthy
> after about 12 s, and `TestLiveRoundTrip` ran 1 test OK:
> `diff_against_input(...).problems == []` for the §15.5 bank, round-tripped through
> the real Honcho REST API. Teardown left 0 containers, and the built api image was
> removed. What this proves: a REST-level round trip against the pinned version,
> with the documented `LOSSY_FIELDS`. What it does not prove: the historical
> "byte-compatible tables" claim, because the interchange is at REST, not
> table-dump, level (R15).
>
> **Table level, 2026-09-27.** The same script now runs `TestLiveTableRoundTrip`
> first. It INSERTs a target-19 bank straight into this database with
> `docker compose exec -T database psql`, then reads it back through REST and
> SQL. The verdict is TRUE WITH CONVERSIONS, not byte-compatible. See
> `docs/overnight/HONCHO-TABLE-DIFF.md`.

Issue #8. Nothing in `arra_migrate.honcho_roundtrip` starts a container. This
file is the manual recipe a human or an agent WITH a working container
runtime follows to run `TestLiveRoundTrip` for real. It was **not executed**
while writing this harness: `docker ps` in this environment fails with
`connect: no such file or directory` against colima's socket, and starting
colima (a VM, host-level state, on a shared machine with other agents active)
is outside what this task authorizes without asking first.

## What gets pinned

See `../pin.py` — `HONCHO_V3_2_0`: git ref `v3.2.0`
(`210b56cf953fcf447ffafcb428d4b4f1823b83fd`), auth off, disposable Postgres,
deriver and embedding disabled. Every route/field name `../target.py` and
`../bundle.py` use was read from that exact ref's `src/routers/*.py` and
`src/schemas/api.py` on 2026-09-21 — re-verify them if this pin is ever
bumped.

## Steps

```bash
# 1. Clone the PINNED ref into a throwaway directory — never the checkout
#    used for anything else, and never white.local's.
git clone --branch v3.2.0 --depth 1 https://github.com/plastic-labs/honcho.git \
  /tmp/honcho-roundtrip-pin
cd /tmp/honcho-roundtrip-pin
git rev-parse HEAD  # must print 210b56cf953fcf447ffafcb428d4b4f1823b83fd — if not, STOP

# 2. Copy the example compose file and env template, then apply pin.py's env
#    (AUTH_USE_AUTH=false, DERIVER_ENABLED=false, EMBED_MESSAGES=false, the
#    Postgres URI already matches docker-compose.yml.example's own database
#    service). NOT DERIVER_WORKERS=0 -- that fails Honcho's own
#    `WORKERS: Field(gt=0)` check at settings-import time and the api
#    container never boots (measured 2026-09-26 against the pinned commit).
cp docker-compose.yml.example docker-compose.yml
cp .env.template .env
#   edit .env: AUTH_USE_AUTH=false, DERIVER_ENABLED=false, EMBED_MESSAGES=false

# 3. Bring up ONLY api + database (skip deriver/redis/mcp — out of tier-1
#    scope and this avoids needing an LLM credential for anything).
#    Ports are 127.0.0.1-bound in the example file already; do not change
#    that binding.
docker compose up -d database api

# 4. Wait for the healthcheck, then point the test at it:
curl -sf http://127.0.0.1:8000/health
export HONCHO_ROUNDTRIP_LIVE_BASE_URL=http://127.0.0.1:8000
cd <this-worktree>/app/migrate-py
uv run python -m unittest tests.test_honcho_roundtrip.TestLiveRoundTrip -v

# 5. Tear down — this is a disposable instance, every time.
cd /tmp/honcho-roundtrip-pin
docker compose down -v
rm -rf /tmp/honcho-roundtrip-pin
```

If step 3 needs an LLM credential anyway (e.g. the image refuses to boot
without one even with the deriver disabled), that is itself a finding worth
recording on issue #8 — do not paper over it by pointing at a shared
instance that already has one configured.
