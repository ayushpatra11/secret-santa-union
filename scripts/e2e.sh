#!/usr/bin/env bash
# Boots the real site with `wrangler pages dev` on a fresh local database and runs the
# browser journey in e2e/. Emails are printed by the console provider into the log,
# which is how the test reads login codes and match links.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8788}"
WORK="$(mktemp -d)"
LOG="$WORK/wrangler.log"
STATE="$WORK/state"
trap 'kill "${PID:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# A throwaway secret just for this run (never reuse real secrets in tests).
if [ ! -f .dev.vars ]; then
  printf 'APP_SECRET=%s\n' "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" > .dev.vars
  CREATED_DEV_VARS=1
fi

if curl -s -o /dev/null "http://localhost:$PORT/"; then
  echo "Port $PORT is already in use. Stop the other server or run with PORT=<free port>." >&2
  exit 1
fi

npx wrangler d1 migrations apply philipwantedagift --local --persist-to "$STATE" > /dev/null
npx wrangler pages dev public --port "$PORT" --persist-to "$STATE" > "$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/config" > /dev/null && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/config" > /dev/null || { cat "$LOG"; exit 1; }

status=0
BASE_URL="http://localhost:$PORT" DEV_LOG="$LOG" node --test e2e/*.e2e.js || status=$?
[ "${CREATED_DEV_VARS:-0}" = 1 ] && rm -f .dev.vars
if [ $status -ne 0 ]; then
  echo '----- wrangler log (emails redacted) -----'
  sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/[email]/g' "$LOG" | tail -100
fi
exit $status
