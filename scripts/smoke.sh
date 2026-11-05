#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_URL="${API_URL:-http://127.0.0.1:25031}"
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

echo "Checking API health..."
HEALTH="$(curl -fsS "$BASE_URL/api/health")"
echo "$HEALTH" | grep -q '"status":"ok"'

echo "Checking public posts..."
curl -fsS "$BASE_URL/api/public/posts?language=ru" >/dev/null

echo "Checking public page..."
curl -fsS "$BASE_URL/" | grep -q 'Ultra Family OS'

echo "Checking private endpoint protection..."
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/auth/me")"
[[ "$STATUS" == "401" ]] || { echo "Expected 401 on /api/auth/me, got $STATUS" >&2; exit 1; }

echo "Checking Stage C collaboration gateway..."
WS_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dWx0cmEtZmFtaWx5LW9zLXNtb2tl' \
  "$API_URL/ws" || true)"
# The gateway must answer the upgrade attempt itself (101 with a session cookie,
# 401/403 without one) instead of returning a missing-route 404.
[[ "$WS_STATUS" == "101" || "$WS_STATUS" == "401" || "$WS_STATUS" == "403" ]] || {
  echo "Expected the /ws collaboration gateway to answer, got $WS_STATUS" >&2
  exit 1
}

echo "Smoke checks passed for $BASE_URL"
