#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP and checks the pages a signed-in non-admin may and may not see.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

# Interim checks while the tracker is built; issue 6 replaces these with the board and
# permission checks from the spec.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/")
[ "$code" = "200" ] || fail "home page should be 200, got $code"
pass "home page renders"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" "$BASE_URL/admin")
case "$code" in 302|303|307|308|403) pass "non-admin kept out of /admin ($code)" ;; *) fail "non-admin /admin should redirect or 403, got $code" ;; esac

# Public board and write protection (issue 6 will fold these into the full rewrite).
board=$(curl -fsS "$BASE_URL/api/board") || fail "GET /api/board failed"
count=$(echo "$board" | grep -o '"n":' | wc -l | tr -d ' ')
[ "$count" = "30" ] || fail "board should list 30 apps, got $count"
pass "board lists 30 apps"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"to":"building"}' "$BASE_URL/api/apps/1/transition")
[ "$code" = "401" ] || fail "anonymous transition should be 401, got $code"
pass "anonymous transition refused (401)"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"to":"building"}' "$BASE_URL/api/apps/1/transition")
[ "$code" = "403" ] || fail "signed-in user transition should be 403, got $code"
pass "non-admin transition refused (403)"

echo "SMOKE PASS"
