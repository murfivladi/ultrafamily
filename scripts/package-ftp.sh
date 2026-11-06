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

# Inlined into the browser bundle and shown in the sidebar, so the running
# frontend build can be compared with the deployed release at a glance.
export NEXT_PUBLIC_APP_VERSION="$VERSION"
echo "Building contracts, API and web application for FTP release $VERSION..."
echo "Frontend internal API origin: $API_PROXY_ORIGIN"
npm run build

# Backend payload: root manifests + compiled API. The server installs only
# the API workspace (see FTP-NOTES.txt); a full install OOMs there.
mkdir -p "$BACKEND/packages/contracts" "$BACKEND/apps/api" "$BACKEND/apps/web"
cp package.json package-lock.json tsconfig.base.json .nvmrc .npmrc .env.example README.md "$BACKEND/"
cp packages/contracts/package.json "$BACKEND/packages/contracts/"
cp -R packages/contracts/dist "$BACKEND/packages/contracts/"
cp apps/api/package.json "$BACKEND/apps/api/"
cp apps/web/package.json "$BACKEND/apps/web/"
cp -R apps/api/dist "$BACKEND/apps/api/"

# Frontend payload: Next.js standalone output (server.js + traced minimal
# node_modules, ~120 MB). The server runs plain `node` and never runs npm,
# so install-time OOM on low-memory hosting is impossible. Static assets and
# public/ are not part of standalone output and must sit next to server.js.
mkdir -p "$FRONTEND/apps/web/.next"
cp -R apps/web/.next/standalone/. "$FRONTEND/"
cp -R apps/web/.next/static "$FRONTEND/apps/web/.next/static"
cp -R apps/web/public "$FRONTEND/apps/web/public"
cp .nvmrc .env.example README.md "$FRONTEND/"

# Next's file tracing conservatively pulls in build-time tooling (webpack,
# terser, esbuild, TypeScript) and sharp's native image binaries. The
# production server never loads them: the app does not use next/image and
# next.config is plain .mjs. They were ~1700 of ~3500 files and ~80 MB, and
# every file is a separate FTPS transfer. Smoke-tested: all routes render.
for pkg in typescript webpack terser uglify-js minimizer-webpack-plugin \
  caniuse-lite @esbuild sharp @img; do
  rm -rf "$FRONTEND/node_modules/$pkg"
done

# Hosting panels start the app with `npm start` (in the root or in apps/web).
# The source scripts call `next start`, but standalone output ships no
# `next` CLI (no node_modules/.bin) -> "sh: next: not found". Point every
# start script of the frontend payload at the standalone server.js instead.
# server.js reads PORT/HOSTNAME; WEB_PORT is honoured for compatibility.
node - "$FRONTEND" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const serve = (file) =>
  `PORT=\${PORT:-\${WEB_PORT:-26287}} HOSTNAME=0.0.0.0 node ${file}`;
const patch = (rel, scripts) => {
  const file = path.join(root, rel);
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.scripts = scripts;
  delete pkg.devDependencies;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
};
patch('package.json', {
  start: serve('apps/web/server.js'),
  'start:web': serve('apps/web/server.js'),
});
patch('apps/web/package.json', { start: serve('server.js') });
NODE

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

This is a Next.js standalone build: apps/web/server.js plus a traced,
minimal node_modules. It is ready to run — do NOT run `npm ci`, `npm
install` or any build here. Installing Next.js on the server OOM-kills
low-memory hosting; that is exactly what this layout avoids.

1. Start the web server from the release root:
     PORT=26287 HOSTNAME=0.0.0.0 node apps/web/server.js
   In a server admin panel, use that as the start command (or set PORT /
   HOSTNAME as process environment variables and run
   `node apps/web/server.js`).
   `npm start` (in the root or in apps/web) also works: in this payload it
   runs server.js, not `next start` — there is no `next` CLI here.
2. The canonical .env is ./.env in this root. See ENV-SETUP.txt.
   APP_ORIGIN already present in your .env is preserved by the workflow.
3. Browser /api and /caldav requests are rewritten to
   http://127.0.0.1:25031 at build time.
   The public address https://api.family.vladislavb.qzz.io is documentation/reverse-proxy only.
EOF

cat > "$BACKEND/ENV-SETUP.txt" <<'EOF'
Backend .env — edit ./.env in the backend FTP root

The workflow already added these generated keys; do not duplicate them
(APP_VERSION is refreshed on every deploy, the others are never overwritten):
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

The workflow already added these generated keys; do not duplicate them
(APP_VERSION is refreshed on every deploy, the others are never overwritten):
  NODE_ENV, APP_VERSION, PORT=26287, WEB_PORT=26287, NEXT_PUBLIC_DEMO_PASSWORD,
  API_PROXY_ORIGIN=http://127.0.0.1:25031,
  APP_ORIGIN if the GitHub variable exists.

APP_ORIGIN was already set by you in ./.env. It is NOT overwritten.
If the GitHub Variable APP_ORIGIN is set but .env still has an old value,
the .env value wins. Edit the existing line, do not add a duplicate key.

The standalone frontend build produced in Actions already targets
http://127.0.0.1:25031 for /api and /caldav rewrites. Do NOT put
https://api.family.vladislavb.qzz.io into API_PROXY_ORIGIN: that external HTTPS request failed
with EPROTO / SSL alert number 40.

If the backend port changes, rerun the FTP workflow to rebuild the
frontend: API_PROXY_ORIGIN is baked into the build, the .env value alone
does not change it. The workflow merges only missing .env keys and will
not overwrite an old external value.

Start command (no npm install/build is needed or wanted here):

  PORT=26287 HOSTNAME=0.0.0.0 node apps/web/server.js

The standalone server reads PORT/HOSTNAME from the process environment,
not from ./.env; set them in the admin panel if it does not import .env.
After changing the port, restart the web process.
EOF

echo "FTP backend payload (prebuilt API): $BACKEND"
echo "FTP frontend payload (prebuilt Next.js standalone, port 26287): $FRONTEND"
