#!/usr/bin/env bash
# Builds the image and runs it the way Railway does (PostgreSQL service plus a
# volume at /data), then checks what a template user depends on:
#   - the image builds and the server starts as an unprivileged user
#   - EmDash's database migrations run against PostgreSQL
#   - the public site renders
#   - the setup wizard is locked behind EMDASH_SETUP_PASSWORD
#   - the first admin can be created and can sign in with a passkey
#   - content can be created and published (database write)
#   - an uploaded image is stored on the volume
#   - the session, the post and the image survive a full restart
# Used locally and by CI. Needs Docker with the compose plugin, curl and Node 20+.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${SMOKE_PROJECT:-emdash-smoke}"
export SITE_PORT="${SMOKE_PORT:-39380}"
export SITE_URL="http://localhost:${SITE_PORT}"
export EMDASH_SETUP_PASSWORD="smoke-$(openssl rand -hex 12)"
export EMDASH_TEMPLATE="${EMDASH_TEMPLATE:-blog}"
# Where each starter keeps the content the test writes, and where it renders it.
case "$EMDASH_TEMPLATE" in
  blog|starter) export SMOKE_COLLECTION=posts SMOKE_PUBLIC_PREFIX=/posts ;;
  portfolio) export SMOKE_COLLECTION=projects SMOKE_PUBLIC_PREFIX=/work ;;
  marketing) export SMOKE_COLLECTION=pages SMOKE_PUBLIC_PREFIX=none ;;
  *) echo "unknown EMDASH_TEMPLATE $EMDASH_TEMPLATE" >&2; exit 2 ;;
esac
STATE="$(mktemp -t emdash-smoke-state.XXXXXX)"

compose() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" "$@"; }

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$STATE"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; compose logs --tail 80 emdash >&2 || true; exit 1; }

wait_healthy() {
  for _ in $(seq 1 120); do
    if curl -fsS "$SITE_URL/_emdash/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "server did not become healthy"
}

client() { node "$ROOT/scripts/smoke-client.mjs" "$1" "$STATE" || fail "smoke client phase '$1' failed"; }

psql_value() { compose exec -T postgres psql -U postgres -d railway -tAc "$1" | tr -d '[:space:]'; }

cleanup
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "== build (template: $EMDASH_TEMPLATE)"
  compose build emdash
fi

echo "== first boot"
compose up -d
wait_healthy
echo "  ok  health check passes"

[ "$(compose exec -T emdash stat -c %U /proc/1)" = "node" ] || fail "server is not running as the unprivileged user"
echo "  ok  server runs as the unprivileged node user"

start_line="$(compose logs --no-log-prefix emdash 2>&1 | grep -m1 "Starting EmDash" || true)"
[ -n "$start_line" ] || fail "entrypoint did not start EmDash"
echo "      $start_line"

home="$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/")"
[ "$home" = "200" ] || fail "home page returned HTTP $home before setup"
echo "  ok  public site renders before setup"

migrations="$(psql_value 'select count(*) from _emdash_migrations')"
[ "${migrations:-0}" -gt 0 ] || fail "no EmDash migrations recorded in PostgreSQL"
echo "  ok  $migrations EmDash migrations applied to PostgreSQL"

compose exec -T emdash sh -c '! find /app -maxdepth 2 -name "*.db" | grep -q .' \
  || fail "a SQLite database file was created instead of using PostgreSQL"
echo "  ok  no SQLite database file in the app directory"

echo "== setup"
client setup

echo "== content and media"
client write
files="$(compose exec -T emdash sh -c 'find /data/uploads -type f | wc -l' | tr -d '[:space:]')"
[ "${files:-0}" -ge 1 ] || fail "no uploaded file found on the volume"
echo "  ok  uploaded file is stored on the volume ($files file(s) in /data/uploads)"
sessions="$(compose exec -T emdash sh -c 'find /data/sessions -type f | wc -l' | tr -d '[:space:]')"
[ "${sessions:-0}" -ge 1 ] || fail "no session file found on the volume"
echo "  ok  sessions are stored on the volume"
rows="$(psql_value "select count(*) from ec_${SMOKE_COLLECTION} where status = 'published'")" || rows=""
[ "${rows:-0}" -ge 1 ] || fail "no published entry found in ec_${SMOKE_COLLECTION}"
echo "  ok  $rows published entr(y/ies) in PostgreSQL table ec_${SMOKE_COLLECTION}"

echo "== restart (containers recreated, volumes kept)"
compose down
compose up -d
wait_healthy
client verify

echo "PASS"
