#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
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

echo "Smoke checks passed for $BASE_URL"
