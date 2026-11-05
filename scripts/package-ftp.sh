#!/usr/bin/env bash
# Build the backend payload in Actions; stage frontend SOURCES so the hosting
# builds Next.js itself. Both payloads keep root manifests for npm ci.
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

echo "Building contracts and API only for FTP release $VERSION..."
echo "Frontend will be built on the hosting, not in GitHub Actions."
npm run build:ftp-backend

for target in "$BACKEND" "$FRONTEND"; do
  mkdir -p "$target/packages/contracts" "$target/apps/api" "$target/apps/web"
  cp package.json package-lock.json tsconfig.base.json .nvmrc .env.example README.md "$target/"
  cp packages/contracts/package.json packages/contracts/tsconfig.json "$target/packages/contracts/"
  cp -R packages/contracts/src packages/contracts/dist "$target/packages/contracts/"
  cp apps/api/package.json "$target/apps/api/"
  cp apps/web/package.json "$target/apps/web/"
done

# Backend remains prebuilt: only compiled API output is uploaded.
cp -R apps/api/dist "$BACKEND/apps/api/"

# Frontend is uploaded as source. .next is generated on the hosting.
cp apps/web/next.config.mjs apps/web/postcss.config.mjs apps/web/tsconfig.json apps/web/next-env.d.ts "$FRONTEND/apps/web/"
cp -R apps/web/src apps/web/public "$FRONTEND/apps/web/"
rm -rf "$FRONTEND/apps/web/.next"

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
for pair in "backend:$BACKEND" "frontend:$FRONTEND"; do
  target_name="${pair%%:*}"
  target_dir="${pair#*:}"
  cat > "$target_dir/RELEASE.json" <<EOF
{
  "version": "$VERSION",
  "target": "$target_name",
  "buildMode": "backend-in-actions; frontend-on-hosting",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitCommit": "$COMMIT"
}
EOF
done

cat > "$BACKEND/FTP-NOTES.txt" <<'EOF'
Ultra Family OS — backend FTP payload

The workflow uploads the CONTENTS of this directory into the backend FTP
account root (./). No artifact/ or payload/ folder is created.

Backend is already compiled in GitHub Actions. Do not run next build here.

1. At the release root run: npm ci --omit=dev
2. Start the API: npm run start:prod -w @ufos/api
3. The canonical .env is ./.env in this root. See ENV-SETUP.txt.
4. Use the existing platform admin panel for first-launch settings.
EOF

cat > "$FRONTEND/FTP-NOTES.txt" <<'EOF'
Ultra Family OS — frontend FTP payload

The workflow uploads the CONTENTS of this directory into the frontend FTP
account root (./). No artifact/ or payload/ folder is created.

This payload contains SOURCES only. There is deliberately no .next/ directory:
Next.js must be built on the hosting after .env is configured.

1. Use Node.js 22 (see .nvmrc).
2. Run: npm ci
   Dev dependencies are required for `next build`; do not use --omit=dev here.
3. Configure ./.env first; see ENV-SETUP.txt.
4. Run: npm run contracts:build
   Then: npm run build -w @ufos/web
5. Start: npm run start -w @ufos/web
6. Rebuild after changing .env values that affect the Next.js build.

See HOSTING-BUILD.txt for the exact command sequence.
EOF

cat > "$FRONTEND/HOSTING-BUILD.txt" <<'EOF'
Build the frontend on the hosting, in the frontend FTP root (./)

Node.js 22 is required (.nvmrc). Commands:

  npm ci
  npm run contracts:build
  npm run build -w @ufos/web
  npm run start -w @ufos/web

Why `npm ci` and not `npm ci --omit=dev`:
  Next.js build needs TypeScript and PostCSS/Tailwind dev dependencies.
  After a successful build you may optionally run `npm prune --omit=dev`,
  because `next` itself is a production dependency.

.env must be ready before the build. In particular APP_ORIGIN and
API_PROXY_ORIGIN are read by apps/web/next.config.mjs. If you change them
later, rebuild with `npm run build -w @ufos/web` and restart the web process.

Expected generated directory: ./apps/web/.next/
It is created on the hosting, not uploaded by GitHub Actions.
EOF

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

No frontend build is needed in this backend payload. After editing .env,
restart the API process in the server admin panel.
EOF

cat > "$FRONTEND/ENV-SETUP.txt" <<'EOF'
Frontend .env — edit ./.env in the frontend FTP root BEFORE building

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

After editing .env run the hosting build again:

  npm run contracts:build
  npm run build -w @ufos/web
  npm run start -w @ufos/web

See HOSTING-BUILD.txt. The workflow uploads sources only; .next is generated
on the hosting, not in GitHub Actions.
EOF

echo "FTP backend payload (prebuilt API): $BACKEND"
echo "FTP frontend payload (sources for hosting build): $FRONTEND"
