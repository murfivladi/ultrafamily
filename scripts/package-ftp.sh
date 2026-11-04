#!/usr/bin/env bash
# Build two independent FTP payloads: backend and frontend.
# Both keep the root package manifests so `npm ci --omit=dev` works on the server.
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

The workflow uploads the CONTENTS of this directory into the FTP account
root (./). It must not create a remote artifact/ or payload/ folder.

1. At the release root run: npm ci --omit=dev
2. Backend:  npm run start:prod -w @ufos/api
   Frontend: npm run start -w @ufos/web
3. The canonical .env is the one in this release root (./.env). API and
   Next.js configuration load it automatically. Do not create app-level
   .env files and do not use a .env inside an old artifact/ folder.
4. See ENV-SETUP.txt for the exact .env keys to enter manually. Generated
   keys are merged into .env by the FTP workflow without overwriting values.
5. Use the existing platform admin panel for the remaining first-launch setup.
EOF
done

cat > "$BACKEND/ENV-SETUP.txt" <<'EOF'
Backend .env — edit ./.env in the backend FTP root

The workflow already added these generated keys; do not duplicate them:
  NODE_ENV, APP_VERSION, SESSION_SECRET, BOOTSTRAP_OWNER_PASSWORD,
  BOOTSTRAP_OWNER_EMAIL, API_PORT, DB_DRIVER, DATABASE_SSL, DB_POOL_SIZE,
  PGLITE_DATA_DIR, SEED_DEMO_DATA, and APP_ORIGIN if the GitHub variable exists.

Add at least these values yourself:

  DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
  APP_ORIGIN=https://family.example

Optional overrides, only if the defaults do not fit your hosting:

  # API_PORT=3101
  # DATABASE_SSL=true
  # DB_POOL_SIZE=8
  # SMTP_URL=smtp://...
  # TELEGRAM_BOT_TOKEN=...

The generated BOOTSTRAP_OWNER_PASSWORD is in this .env. Read it here and use
it with BOOTSTRAP_OWNER_EMAIL for the first login. It is generated once and is
never overwritten by later deploys. If you want a different password, edit the
existing line before the first login; do not add a duplicate key.

After editing .env, restart the API process in the server admin panel.
Other first-run settings belong to the existing platform admin panel.
EOF

cat > "$FRONTEND/ENV-SETUP.txt" <<'EOF'
Frontend .env — edit ./.env in the frontend FTP root

The workflow already added these generated keys; do not duplicate them:
  NODE_ENV, APP_VERSION, WEB_PORT, NEXT_PUBLIC_DEMO_PASSWORD,
  APP_ORIGIN if the GitHub variable exists,
  API_PROXY_ORIGIN if the GitHub variable exists.

Add at least:

  API_PROXY_ORIGIN=http://127.0.0.1:3001

Use the internal address where the Nest API process is reachable from the
Next.js process. If the hosting panel provides a different port, change it:

  # WEB_PORT=3100
  # APP_ORIGIN=https://family.example

APP_ORIGIN must match the public site origin exactly, without a trailing slash.
After editing .env, restart the web process in the server admin panel.
EOF

echo "FTP backend payload: $BACKEND"
echo "FTP frontend payload: $FRONTEND"
