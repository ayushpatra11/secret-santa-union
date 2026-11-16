#!/usr/bin/env bash
# Boots the real site with `wrangler dev` on a fresh local database and runs the
# browser journey in e2e/, signing in through a fake local Google (e2e/fake-oidc.js).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8788}"
WORK="$(mktemp -d)"
LOG="$WORK/wrangler.log"
STATE="$WORK/state"
cleanup() {
  kill "${PID:-0}" "${OIDC_PID:-0}" 2>/dev/null || true
  # Only touch .dev.vars if this script replaced it.
  if [ "${SWAPPED_DEV_VARS:-0}" = 1 ]; then
    rm -f .dev.vars
    if [ -f "$WORK/dev.vars.backup" ]; then mv "$WORK/dev.vars.backup" .dev.vars; fi
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

for p in "$PORT" "${OAUTH_PORT:-8799}"; do
  if curl -s -o /dev/null "http://localhost:$p/"; then
    echo "Port $p is already in use. Stop the other server or set PORT / OAUTH_PORT." >&2
    exit 1
  fi
done

# Run with a throwaway config: move any personal .dev.vars aside and restore it on exit.
OAUTH_PORT="${OAUTH_PORT:-8799}"
SWAPPED_DEV_VARS=1
if [ -f .dev.vars ]; then mv .dev.vars "$WORK/dev.vars.backup"; fi
printf 'APP_SECRET=%s\nAPP_URL=http://localhost:%s\nDEV_OAUTH_BASE=http://localhost:%s\nGOOGLE_CLIENT_ID=e2e\nGOOGLE_CLIENT_SECRET=e2e\n' \
  "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" "$PORT" "$OAUTH_PORT" > .dev.vars

node e2e/fake-oidc.js "$OAUTH_PORT" > "$WORK/oidc.log" 2>&1 &
OIDC_PID=$!

npx wrangler d1 migrations apply philipwantedagift --local --persist-to "$STATE" > /dev/null
npx wrangler dev --port "$PORT" --persist-to "$STATE" > "$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/config" > /dev/null && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/config" > /dev/null || { cat "$LOG"; exit 1; }

status=0
BASE_URL="http://localhost:$PORT" node --test e2e/*.e2e.js || status=$?
if [ $status -ne 0 ]; then
  echo '----- wrangler log -----'
  sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/[email]/g' "$LOG" | tail -100
fi
exit $status
