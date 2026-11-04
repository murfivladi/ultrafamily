#!/usr/bin/env bash
# Build two independent FTP payloads: backend and frontend.
# Both keep the root package manifests so `npm ci --omit=dev` works on the VPS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RAW_VERSION="${1:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)}"
VERSION="$(printf '%s' "$RAW_VERSION" | sed -E 's/[^A-Za-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
if [ -z "$VERSION" ]; then
  echo 'Could not derive a safe release version.' >&2
  exit 1
fi

OUT="$ROOT/releases/ftp"
BACKEND="$OUT/backend"
FRONTEND="$OUT/frontend"
rm -rf "$BACKEND" "$FRONTEND"
mkdir -p "$BACKEND" "$FRONTEND"

echo "Building contracts, API and web application for FTP release $VERSION..."
npm run build

for target in "$BACKEND" "$FRONTEND"; do
  mkdir -p "$target/packages/contracts" "$target/apps/api" "$target/apps/web"
  cp package.json package-lock.json tsconfig.base.json .env.example README.md "$target/"
  cp packages/contracts/package.json "$target/packages/contracts/"
  cp -R packages/contracts/dist "$target/packages/contracts/"
  cp apps/api/package.json "$target/apps/api/"
  cp apps/web/package.json "$target/apps/web/"
done

cp -R apps/api/dist "$BACKEND/apps/api/"
cp apps/web/next.config.mjs apps/web/postcss.config.mjs "$FRONTEND/apps/web/"
cp -R apps/web/.next "$FRONTEND/apps/web/"
cp -R apps/web/public "$FRONTEND/apps/web/"

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
for pair in "backend:$BACKEND" "frontend:$FRONTEND"; do
  target_name="${pair%%:*}"
  target_dir="${pair#*:}"
  cat > "$target_dir/RELEASE.json" <<EOF
{
  "version": "$VERSION",
  "target": "$target_name",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitCommit": "$COMMIT"
}
EOF
  cat > "$target_dir/FTP-NOTES.txt" <<'EOF'
Ultra Family OS — FTP payload

1. At the release root run: npm ci --omit=dev
2. Backend:  npm run start:prod -w @ufos/api
   Frontend: npm run start -w @ufos/web
3. The canonical .env is the one in this release root. API and Next.js
   configuration load it automatically. Do not create a separate app-level
   .env unless you know exactly why you need it.
4. Enter DATABASE_URL, APP_ORIGIN, API_PROXY_ORIGIN, ports and any other
   installation-specific values yourself. Automatically generated keys are
   merged into .env by the FTP workflow without overwriting existing values.
5. Use the existing platform admin panel for the remaining first-launch setup.
EOF
done

echo "FTP backend payload: $BACKEND"
echo "FTP frontend payload: $FRONTEND"
