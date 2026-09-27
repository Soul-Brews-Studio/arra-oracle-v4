#!/usr/bin/env bash
# Issue #8 live leg, one command: bash app/just/honcho-live.sh
#
# Runs app/migrate-py/src/arra_migrate/honcho_roundtrip/docker/README.md as
# written: a DISPOSABLE Honcho at the pinned v3.2.0 commit (api + database
# only; auth, deriver and embeddings off; 127.0.0.1-bound), then BOTH legs
# against it -- TestLiveRoundTrip (REST interchange) and
# TestLiveTableRoundTrip (plain SQL INSERTs via psql inside the database
# container, read back through REST and SQL; R15 2026-09-27 update) -- then
# a teardown that always runs: containers, volumes, the clone, the built
# image. Needs a
# container runtime that is already up (Docker Desktop here); this script
# never starts one. It never touches white.local or any shared instance: the
# test itself refuses a non-loopback URL. First run 2026-09-27 (m5): the
# api was healthy after ~12 s, the test ran 1 OK, and teardown left 0
# containers.
set -uo pipefail
PIN=/tmp/honcho-roundtrip-pin
SHA=210b56cf953fcf447ffafcb428d4b4f1823b83fd
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT=honcho-rt-pin

teardown() {
  echo "== teardown =="
  if [ -f "$PIN/docker-compose.yml" ]; then (cd "$PIN" && docker compose -p "$PROJECT" down -v --remove-orphans); fi
  rm -rf "$PIN"
  docker image rm "$PROJECT-api:latest" >/dev/null 2>&1 || true
  echo "TEARDOWN done: $(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" -q | wc -l | tr -d ' ') containers," \
    "$(docker volume ls --filter "label=com.docker.compose.project=$PROJECT" -q | wc -l | tr -d ' ') volumes," \
    "$(docker image ls -q "$PROJECT-api" | wc -l | tr -d ' ') images left; clone $([ -e "$PIN" ] && echo PRESENT || echo removed)"
}
trap teardown EXIT
trap 'exit 130' INT TERM

if [ -e "$PIN" ]; then echo "REFUSING: $PIN already exists"; trap - EXIT; exit 2; fi
git clone --quiet --branch v3.2.0 --depth 1 https://github.com/plastic-labs/honcho.git "$PIN" || exit 3
cd "$PIN"
HEAD_SHA=$(git rev-parse HEAD)
echo "pinned HEAD $HEAD_SHA"
[ "$HEAD_SHA" = "$SHA" ] || { echo "STOP: pin mismatch"; exit 4; }

if curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1; then
  echo "REFUSING: something already answers on 127.0.0.1:8000 -- not ours to write to"; exit 7
fi

cp docker-compose.yml.example docker-compose.yml
cp .env.template .env
for kv in AUTH_USE_AUTH=false DERIVER_ENABLED=false EMBED_MESSAGES=false; do
  k=${kv%%=*}
  if grep -q "^$k=" .env; then sed -i '' "s|^$k=.*|$kv|" .env; else echo "$kv" >> .env; fi
done
grep -E '^(AUTH_USE_AUTH|DERIVER_ENABLED|EMBED_MESSAGES)=' .env
grep -nE '^\s*-\s*"?[0-9.]*:?[0-9]+:[0-9]+' docker-compose.yml || true

docker compose -p "$PROJECT" up -d --build database api || exit 5

echo "== waiting for /health =="
for i in $(seq 1 120); do
  if curl -sf http://127.0.0.1:8000/health >/dev/null; then echo "healthy after ~$((i * 3))s"; break; fi
  sleep 3
done
curl -sf http://127.0.0.1:8000/health || { echo "API never became healthy"; docker compose -p "$PROJECT" logs --tail 40 api; exit 6; }
echo

cd "$REPO/app/migrate-py"
# Table leg FIRST, on the fresh database -- the SPEC §15 scenario (a bank
# imported into stock Honcho). Run after the REST leg instead, its messages
# 1..10 collide with the REST leg's identity ids on pk_messages: measured
# 2026-09-27, and now asserted inside the test itself with a second bank.
HONCHO_ROUNDTRIP_LIVE_BASE_URL=http://127.0.0.1:8000 \
HONCHO_TABLE_LIVE_COMPOSE_DIR="$PIN" HONCHO_TABLE_LIVE_COMPOSE_PROJECT="$PROJECT" \
  uv run python -m unittest tests.test_honcho_table.TestLiveTableRoundTrip -v
TRC=$?
echo "LIVE_TABLE_ROUNDTRIP_RC=$TRC"

HONCHO_ROUNDTRIP_LIVE_BASE_URL=http://127.0.0.1:8000 \
  uv run python -m unittest tests.test_honcho_roundtrip.TestLiveRoundTrip -v
RC=$?
echo "LIVE_ROUNDTRIP_RC=$RC"
[ "$RC" -eq 0 ] && [ "$TRC" -eq 0 ]
