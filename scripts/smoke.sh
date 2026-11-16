#!/usr/bin/env bash
# Post-deploy smoke test: the site is up, security headers are present, and the API
# refuses anonymous and cross-site requests. Usage: scripts/smoke.sh https://example.com
set -euo pipefail
BASE="${1%/}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

for i in $(seq 1 10); do curl -sf "$BASE/" -o /dev/null && break; sleep 3; done

headers="$(curl -sfI "$BASE/")" || fail "home page not reachable"
for h in content-security-policy strict-transport-security x-content-type-options x-frame-options referrer-policy; do
  grep -qi "^$h:" <<< "$headers" || fail "missing header $h"
done
grep -qi "frame-ancestors 'none'" <<< "$headers" || fail "CSP must forbid framing"

curl -sf "$BASE/api/config" | grep -q '"providers"' || fail "/api/config not working"
curl -sf "$BASE/api/me" | grep -q '"user":null' || fail "/api/me should be anonymous"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/exchanges")"
[ "$code" = 401 ] || fail "/api/exchanges should require login (got $code)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'origin: https://evil.example' -H 'content-type: application/json' -d '{"email":"x@example.com"}' "$BASE/api/auth/request-otp")"
[ "$code" = 403 ] || fail "cross-site POST should be blocked (got $code)"
echo "Smoke test passed for $BASE"
