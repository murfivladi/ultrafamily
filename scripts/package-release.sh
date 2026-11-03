#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="${1:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)}"
RELEASES="$ROOT/releases"
ARCHIVE="$RELEASES/ufos-$VERSION.tar.gz"
mkdir -p "$RELEASES"

echo "Building contracts, API and web application..."
npm run build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/release"

# Prebuilt application artifacts only. Secrets, VCS data, databases and node_modules
# are never part of the uploaded archive.
cp package.json package-lock.json tsconfig.base.json .env.example README.md "$STAGE/release/"
cp -R docs scripts docker-compose.yml Dockerfile.api Dockerfile.web "$STAGE/release/"
mkdir -p "$STAGE/release/packages/contracts" "$STAGE/release/apps/api" "$STAGE/release/apps/web"
cp packages/contracts/package.json "$STAGE/release/packages/contracts/"
cp -R packages/contracts/dist "$STAGE/release/packages/contracts/"
cp apps/api/package.json "$STAGE/release/apps/api/"
cp -R apps/api/dist "$STAGE/release/apps/api/"
cp apps/web/package.json apps/web/next.config.mjs apps/web/postcss.config.mjs "$STAGE/release/apps/web/"
cp -R apps/web/.next "$STAGE/release/apps/web/"
cp -R apps/web/public "$STAGE/release/apps/web/"

cat > "$STAGE/release/RELEASE.json" <<EOF
{
  "version": "$VERSION",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitCommit": "$(git rev-parse HEAD 2>/dev/null || echo unknown)",
  "artifact": "ufos-$VERSION.tar.gz"
}
EOF

tar -czf "$ARCHIVE" -C "$STAGE" release
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
echo "Release archive: $ARCHIVE"
echo "Deploy this exact version, verify it, then switch the current release. Secrets stay outside the archive."
