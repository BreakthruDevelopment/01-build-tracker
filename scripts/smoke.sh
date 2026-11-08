#!/usr/bin/env bash
# Read-only tracker checks plus one fresh, unprivileged test account.
#   BASE_URL=https://app1.breakthruventures.ai pnpm smoke
# Node is already required by the app; use its JSON parser rather than adding jq.
set -euo pipefail

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
RUN_ID="$(date +%s)-$RANDOM-$RANDOM"
SMOKE_TMP="$(mktemp -d)" || fail "could not create temporary files"
trap 'rm -rf "$SMOKE_TMP"' EXIT
JAR="$SMOKE_TMP/cookies"
BODY="$SMOKE_TMP/body"

# No redirects or implicit retries: each check after readiness makes one request.
# Ignore user curl configuration so it cannot attach credentials to these probes.
request() {
  local method=$1 path=$2
  shift 2
  local -a origin=()
  if [[ "$method" == POST ]]; then origin=(-H "Origin: $BASE_URL"); fi
  smoke_code=$(curl --disable --silent --show-error --connect-timeout 10 --max-time 30 \
    -o "$BODY" -w '%{http_code}' -X "$method" "${origin[@]}" "$@" "$BASE_URL$path") \
    || fail "$method $path could not complete"
}

expect_status() {
  local method=$1 path=$2 expected=$3
  shift 3
  request "$method" "$path" "$@"
  [[ "$smoke_code" =~ ^($expected)$ ]] \
    || fail "$method $path expected HTTP $expected, got $smoke_code"
  pass "$method $path ($smoke_code)"
}

# Lambda can cold-start. Bound requests and sleeps by one total 60-second budget.
health_deadline=$((SECONDS + 60))
healthy=false
while (( SECONDS < health_deadline )); do
  remaining=$((health_deadline - SECONDS))
  attempt_timeout=$((remaining < 10 ? remaining : 10))
  if smoke_code=$(curl --disable --silent --show-error --connect-timeout "$attempt_timeout" \
      --max-time "$attempt_timeout" -o "$BODY" -w '%{http_code}' "$BASE_URL/api/health") \
    && [[ "$smoke_code" == 200 ]] \
    && node -e 'try { if (JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).status !== "ok") process.exit(1); } catch { process.exit(1); }' "$BODY"; then
    healthy=true
    break
  fi
  remaining=$((health_deadline - SECONDS))
  if (( remaining > 0 )); then sleep "$((remaining < 3 ? remaining : 3))"; fi
done
[[ "$healthy" == true ]] || fail "GET /api/health did not report ok within 60 seconds"
pass "health ready"

expect_status GET /api/board 200
node -e 'try { const { apps } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (!Array.isArray(apps) || apps.length !== 30) process.exit(1); } catch { process.exit(1); }' "$BODY" \
  || fail "GET /api/board must return valid JSON containing exactly 30 apps"
pass "board lists exactly 30 apps"

for path in / /sign-in; do
  expect_status GET "$path" 200
  grep -Eq '<footer[^>]*>.*href="https://breakthruventures[.]ai/?"' "$BODY" \
    || fail "GET $path is missing the shared footer link to breakthruventures.ai"
done
expect_status GET /apps/1 200
expect_status GET /apps/999 404
expect_status GET /admin '3[0-9][0-9]'

# Exactly one fresh user; this known throwaway password is never a real credential.
expect_status POST /api/auth/sign-up/email '2[0-9][0-9]' -c "$JAR" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"smoke-$RUN_ID@example.test\",\"password\":\"smoke-test-password-$RUN_ID\",\"name\":\"Smoke\"}"
expect_status GET /admin '3[0-9][0-9]' -b "$JAR"

# Auth must reject first. Even if it regresses, this invalid destination cannot
# change an app's status; never submit an authorized transition in a smoke test.
expect_status POST /api/apps/1/transition 401 -H 'Content-Type: application/json' -d '{"to":"smoke-invalid-status"}'
expect_status POST /api/apps/1/transition 403 -b "$JAR" -H 'Content-Type: application/json' -d '{"to":"smoke-invalid-status"}'

# Machine probes carry neither session cookies nor bearer credentials.
expect_status POST /api/webhooks/github '401|503' -H 'Content-Type: application/json' \
  -H 'x-github-event: push' -H "x-github-delivery: smoke-$RUN_ID" -H 'x-hub-signature-256: sha256=00' -d '{}'
expect_status POST /api/ingest '401|503' -H 'Content-Type: application/json' -d '{}'
expect_status POST /api/sync 401
expect_status POST /api/summaries/run 401

echo "SMOKE PASS"
