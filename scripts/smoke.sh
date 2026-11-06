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
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$API_URL/ws" || true)"
# The gateway must answer the upgrade attempt itself (101 with a session cookie,
# 401/403 without one) instead of returning a missing-route 404.
[[ "$WS_STATUS" == "101" || "$WS_STATUS" == "401" || "$WS_STATUS" == "403" ]] || {
  echo "Expected the /ws collaboration gateway to answer, got $WS_STATUS" >&2
  exit 1
}

echo "Checking /ws through the public web origin (Next rewrite)..."
WEB_WS_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$BASE_URL/ws" || true)"
# 000 means the proxy accepted the upgrade and never answered: calls would hang in "connecting".
[[ "$WEB_WS_STATUS" == "101" || "$WEB_WS_STATUS" == "401" || "$WEB_WS_STATUS" == "403" ]] || {
  echo "Expected /ws on $BASE_URL to reach the gateway, got $WEB_WS_STATUS" >&2
  exit 1
}

echo "Checking Stage D WebDAV endpoint..."
DAV_HEADERS="$(curl -sS -o /dev/null -D - -X OPTIONS "$BASE_URL/api/webdav/smoke/" || true)"
echo "$DAV_HEADERS" | grep -qi '^dav:' || { echo "WebDAV OPTIONS did not return a DAV header" >&2; exit 1; }
DAV_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X PROPFIND "$BASE_URL/api/webdav/smoke/" || true)"
[[ "$DAV_STATUS" == "401" ]] || { echo "Expected 401 for WebDAV without a token, got $DAV_STATUS" >&2; exit 1; }

echo "Smoke checks passed for $BASE_URL"
