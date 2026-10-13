#!/usr/bin/env bash
# Starts the EmDash site with uploads and sessions on the persistent volume.
#
# EmDash bakes its database config into the build, so the connection string is
# not read from DATABASE_URL directly. pg falls back to the standard PG*
# variables, so DATABASE_URL is split into those here at start-up.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
APP_USER=node

log() { echo "[railway-entrypoint] $*"; }

# Railway mounts volumes as root. Fix ownership once, then drop privileges.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/sessions"
  if [ "$(stat -c %U "$DATA_DIR")" != "$APP_USER" ] || [ "$(stat -c %U "$DATA_DIR/uploads")" != "$APP_USER" ]; then
    log "Giving $APP_USER ownership of $DATA_DIR"
    chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  fi
  exec gosu "$APP_USER" "$0" "$@"
fi

mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/sessions"

# A key pasted into Railway with a stray newline or space would be rejected
# by EmDash, so strip whitespace before it starts.
if [ -n "${EMDASH_ENCRYPTION_KEY:-}" ]; then
  EMDASH_ENCRYPTION_KEY="$(printf '%s' "$EMDASH_ENCRYPTION_KEY" | tr -d '[:space:]')"
  export EMDASH_ENCRYPTION_KEY
fi

if [ -n "${DATABASE_URL:-}" ] && [ -z "${PGHOST:-}" ]; then
  # Prints shell-quoted exports. Node is used because URL parsing and
  # percent-decoding of passwords are easy to get wrong in shell.
  eval "$(node -e '
    const u = new URL(process.env.DATABASE_URL);
    const q = (s) => "\x27" + String(s).replaceAll("\x27", "\x27\\\x27\x27") + "\x27";
    const out = {
      PGHOST: u.hostname.replace(/^\[|\]$/g, ""),
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    };
    const sslmode = u.searchParams.get("sslmode");
    if (sslmode) out.PGSSLMODE = sslmode;
    for (const [k, v] of Object.entries(out)) console.log(`export ${k}=${q(v)}`);
  ')"
fi

if [ -z "${PGHOST:-}" ]; then
  log "ERROR: no database configured. Set DATABASE_URL to \${{Postgres.DATABASE_URL}}."
  exit 1
fi

if [ -z "${EMDASH_SITE_URL:-}" ] && [ -z "${SITE_URL:-}" ]; then
  log "WARNING: EMDASH_SITE_URL is not set. EmDash refuses to run setup in production without it."
  log "WARNING: Set it to https://\${{RAILWAY_PUBLIC_DOMAIN}}."
fi

if [ -z "${EMDASH_SETUP_PASSWORD:-}" ]; then
  log "WARNING: EMDASH_SETUP_PASSWORD is not set."
  log "WARNING: Until an admin exists, the first person to open /_emdash/admin can create it."
fi

log "Starting EmDash $(node -p 'require("/app/node_modules/emdash/package.json").version' 2>/dev/null || echo '') on port ${PORT:-8080} (database ${PGHOST}:${PGPORT:-5432}/${PGDATABASE:-})"
exec "$@"
