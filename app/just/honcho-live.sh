#!/usr/bin/env bash
# Issue #8 live leg, one command: bash app/just/honcho-live.sh
#
# Runs app/migrate-py/src/arra_migrate/honcho_roundtrip/docker/README.md as
# written: a DISPOSABLE Honcho at the pinned v3.2.0 commit (api + database
# only; auth, deriver and embeddings off; 127.0.0.1-bound), then
# TestLiveRoundTrip against it, then a teardown that always runs. Needs a
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
  echo "TEARDOWN done: $(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" -q | wc -l | tr -d ' ') containers left"
}
trap teardown EXIT

if [ -e "$PIN" ]; then echo "REFUSING: $PIN already exists"; trap - EXIT; exit 2; fi
git clone --quiet --branch v3.2.0 --depth 1 https://github.com/plastic-labs/honcho.git "$PIN" || exit 3
cd "$PIN"
HEAD_SHA=$(git rev-parse HEAD)
echo "pinned HEAD $HEAD_SHA"
[ "$HEAD_SHA" = "$SHA" ] || { echo "STOP: pin mismatch"; exit 4; }

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
HONCHO_ROUNDTRIP_LIVE_BASE_URL=http://127.0.0.1:8000 \
  uv run python -m unittest tests.test_honcho_roundtrip.TestLiveRoundTrip -v
RC=$?
echo "LIVE_ROUNDTRIP_RC=$RC"
exit $RC
