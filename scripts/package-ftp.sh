#!/usr/bin/env bash
# Build backend and frontend in GitHub Actions; upload two prebuilt FTP payloads.
# Both keep root manifests so a workspace-scoped `npm ci --omit=dev
# --workspace=@ufos/api|@ufos/web` works on the server without installing
# the whole monorepo (a full install OOMs on low-memory hosting).
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

# next.config.mjs reads API_PROXY_ORIGIN while producing .next. Keep this
# INTERNAL: an external HTTPS proxy caused EPROTO SSL alert 40 on the hosting.
export API_PROXY_ORIGIN="${API_PROXY_ORIGIN:-http://127.0.0.1:25031}"
if [ "$API_PROXY_ORIGIN" = 'https://api.family.vladislavb.qzz.io' ]; then
  echo 'Use the internal backend http://127.0.0.1:25031 for API_PROXY_ORIGIN, not the public HTTPS domain.' >&2
  exit 1
fi

echo "Building contracts, API and web application for FTP release $VERSION..."
echo "Frontend internal API origin: $API_PROXY_ORIGIN"
npm run build

for target in "$BACKEND" "$FRONTEND"; do
  mkdir -p "$target/packages/contracts" "$target/apps/api" "$target/apps/web"
  cp package.json package-lock.json tsconfig.base.json .nvmrc .npmrc .env.example README.md "$target/"
  cp packages/contracts/package.json "$target/packages/contracts/"
  cp -R packages/contracts/dist "$target/packages/contracts/"
  cp apps/api/package.json "$target/apps/api/"
  cp apps/web/package.json "$target/apps/web/"
done

cp -R apps/api/dist "$BACKEND/apps/api/"
cp apps/web/next.config.mjs apps/web/postcss.config.mjs "$FRONTEND/apps/web/"
cp -R apps/web/.next apps/web/public "$FRONTEND/apps/web/"
# .next/cache is a webpack BUILD cache, not a next start runtime dependency.
# It can contain multi-hundred-MB .pack files; keep it out of FTP artifacts.
rm -rf "$FRONTEND/apps/web/.next/cache"

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
for pair in "backend:$BACKEND" "frontend:$FRONTEND"; do
  target_name="${pair%%:*}"
  target_dir="${pair#*:}"
  cat > "$target_dir/RELEASE.json" <<EOF
{
  "version": "$VERSION",
  "target": "$target_name",
  "buildMode": "backend-and-frontend-in-actions",
  "frontendPort": 26287,
  "apiProxyOrigin": "$API_PROXY_ORIGIN",
  "apiPublicOrigin": "https://api.family.vladislavb.qzz.io",
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

1. At the release root install ONLY the API workspace:
     npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@ufos/api --include-workspace-root=false
   Do NOT run a bare `npm ci --omit=dev` here: it installs every workspace
   (including Next.js/React for the frontend) and peaks at ~0.8 GB RAM,
   which gets the process OOM-killed on 1-2 GB hosting. The scoped install
   above peaks at ~0.25 GB and is enough for the API.
2. Start the API on API_PORT=25031: npm run start:prod -w @ufos/api
3. The canonical .env is ./.env in this root. See ENV-SETUP.txt.
   APP_ORIGIN already present in your .env is preserved by the workflow.
   If API_PORT there is still 3001, edit that existing line to 25031.
4. Use the existing platform admin panel for first-launch settings.
EOF

cat > "$FRONTEND/FTP-NOTES.txt" <<'EOF'
Ultra Family OS — frontend FTP payload

The workflow uploads the CONTENTS of this directory into the frontend FTP
account root (./). No artifact/ or payload/ folder is created.

Frontend is already compiled in GitHub Actions: apps/web/.next is included.
The .next/cache webpack build cache and *.pack files are deliberately
excluded: they are not needed by `next start` and can be very large.

1. At the release root install ONLY the web workspace:
     npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@ufos/web --include-workspace-root=false
   Do NOT run a bare `npm ci --omit=dev` here: it installs every workspace
   (including NestJS/Jest for the backend) and peaks at ~0.8 GB RAM, which
   gets the process OOM-killed on 1-2 GB hosting. Even scoped, Next.js
   packages are large, so stop the API/other Node processes during install
   and prefer a host with >=1 GB free RAM (or add swap).
2. Start the web server: npm run start -w @ufos/web
   It listens on WEB_PORT=26287 by default.
3. The canonical .env is ./.env in this root. See ENV-SETUP.txt.
   APP_ORIGIN already present in your .env is preserved by the workflow.
4. Browser /api and /caldav requests are rewritten to
   http://127.0.0.1:25031 at build time.
   The public address https://api.family.vladislavb.qzz.io is documentation/reverse-proxy only.
EOF

cat > "$BACKEND/ENV-SETUP.txt" <<'EOF'
Backend .env — edit ./.env in the backend FTP root

The workflow already added these generated keys; do not duplicate them:
  NODE_ENV, APP_VERSION, SESSION_SECRET, BOOTSTRAP_OWNER_PASSWORD,
  BOOTSTRAP_OWNER_EMAIL, API_PORT=25031, DB_DRIVER, DATABASE_SSL, DB_POOL_SIZE,
  PGLITE_DATA_DIR, SEED_DEMO_DATA, and APP_ORIGIN if the GitHub variable exists.

APP_ORIGIN was already set by you in ./.env. It is NOT overwritten.
If the GitHub Variable APP_ORIGIN is set but .env still has an old value,
the .env value wins. Edit the existing line, do not add a duplicate key.

Add at least these values yourself:

  DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE

Optional overrides, only if the defaults do not fit your hosting:

  # API_PORT=25031
  # DATABASE_SSL=true
  # DB_POOL_SIZE=8
  # SMTP_URL=smtp://...
  # TELEGRAM_BOT_TOKEN=...

The generated BOOTSTRAP_OWNER_PASSWORD is in this .env. Read it here and use
it with BOOTSTRAP_OWNER_EMAIL for the first login. It is generated once and is
never overwritten by later deploys. If you want a different password, edit the
existing line before the first login; do not add a duplicate key.

After editing .env, restart the API process in the server admin panel.
EOF

cat > "$FRONTEND/ENV-SETUP.txt" <<'EOF'
Frontend .env — edit ./.env in the frontend FTP root

The workflow already added these generated keys; do not duplicate them:
  NODE_ENV, APP_VERSION, WEB_PORT=26287, NEXT_PUBLIC_DEMO_PASSWORD,
  API_PROXY_ORIGIN=http://127.0.0.1:25031,
  APP_ORIGIN if the GitHub variable exists.

APP_ORIGIN was already set by you in ./.env. It is NOT overwritten.
If the GitHub Variable APP_ORIGIN is set but .env still has an old value,
the .env value wins. Edit the existing line, do not add a duplicate key.

The frontend .next build produced in Actions already targets
http://127.0.0.1:25031 for /api and /caldav rewrites. Do NOT put
https://api.family.vladislavb.qzz.io into API_PROXY_ORIGIN: that external HTTPS request failed
with EPROTO / SSL alert number 40.

If the backend port changes, edit the existing API_PROXY_ORIGIN line in
./.env and rerun the FTP workflow to rebuild .next. The workflow merges
only missing .env keys and will not overwrite an old external value.

Start command:

  npm run start -w @ufos/web

It uses WEB_PORT=26287 (or an exported WEB_PORT override). No build is
needed on the hosting. After editing .env, restart the web process.
EOF

echo "FTP backend payload (prebuilt API): $BACKEND"
echo "FTP frontend payload (prebuilt Next.js, port 26287): $FRONTEND"
