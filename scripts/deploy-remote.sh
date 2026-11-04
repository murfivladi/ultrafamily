#!/usr/bin/env bash
# Executed on the VPS by .github/workflows/deploy.yml via SSH stdin.
# All inputs are passed as UFOS_* environment variables; production secrets stay
# in UFOS_ENV_FILE outside the release directory.
set -euo pipefail

: "${UFOS_VERSION:?UFOS_VERSION is required}"
: "${UFOS_ARCHIVE:?UFOS_ARCHIVE is required}"
: "${UFOS_CHECKSUM:?UFOS_CHECKSUM is required}"
: "${UFOS_BASE_URL:?UFOS_BASE_URL is required}"

UFOS_ROOT="${UFOS_ROOT:-/srv/ufos}"
UFOS_ENV_FILE="${UFOS_ENV_FILE:-/etc/ufos/env}"
UFOS_RESTART_CMD="${UFOS_RESTART_CMD:-sudo systemctl restart ufos-api ufos-web}"

cd "$UFOS_ROOT"
mkdir -p releases
sha256sum -c "releases/$UFOS_CHECKSUM"

if [ -L "$UFOS_ROOT/current" ] || [ -d "$UFOS_ROOT/current" ]; then
  echo 'Creating an encrypted off-VPS backup before deployment.'
  if [ ! -f "$UFOS_ENV_FILE" ]; then
    echo "Missing $UFOS_ENV_FILE" >&2
    exit 1
  fi
  (
    set +u
    set -a
    # shellcheck disable=SC1090
    . "$UFOS_ENV_FILE"
    set +a
    set -u
    : "${DATABASE_URL:?DATABASE_URL is required in the VPS environment file}"
    : "${AGE_RECIPIENT:?AGE_RECIPIENT is required for encrypted backups}"
    : "${BACKUP_REMOTE:?BACKUP_REMOTE is required for off-VPS backups}"
    command -v pg_dump >/dev/null || { echo 'pg_dump is required on the VPS.' >&2; exit 1; }
    command -v age >/dev/null || { echo 'age is required on the VPS.' >&2; exit 1; }
    command -v rclone >/dev/null || { echo 'rclone is required on the VPS.' >&2; exit 1; }
    cd "$UFOS_ROOT/current"
    APP_VERSION="$UFOS_VERSION" npm run db:backup
  )
else
  echo 'First deploy: no current release, skipping the pre-migration backup.'
fi

release_dir="$UFOS_ROOT/releases/$UFOS_VERSION"
rm -rf "$release_dir"
mkdir -p "$release_dir"
tar -xzf "releases/$UFOS_ARCHIVE" -C "$release_dir" --strip-components=1
(cd "$release_dir" && npm ci --omit=dev --ignore-scripts=false)

previous=''
if [ -L "$UFOS_ROOT/current" ]; then
  previous="$(readlink -f "$UFOS_ROOT/current" || true)"
elif [ -d "$UFOS_ROOT/current" ]; then
  previous="$UFOS_ROOT/current"
fi

ln -sfn "$release_dir" "$UFOS_ROOT/current.next"
mv -Tf "$UFOS_ROOT/current.next" "$UFOS_ROOT/current"
bash -c "$UFOS_RESTART_CMD"

base_url="${UFOS_BASE_URL%/}"
echo "Waiting for $base_url/api/health ..."
healthy=0
for _ in $(seq 1 20); do
  if curl -fsS "$base_url/api/health" | grep -q '"status":"ok"'; then
    healthy=1
    break
  fi
  sleep 3
done

if [ "$healthy" -ne 1 ]; then
  echo 'Health check failed.' >&2
  if [ -n "$previous" ]; then
    echo "Rolling the symlink back to $previous"
    ln -sfn "$previous" "$UFOS_ROOT/current.next"
    mv -Tf "$UFOS_ROOT/current.next" "$UFOS_ROOT/current"
    bash -c "$UFOS_RESTART_CMD"
  fi
  exit 1
fi

(cd "$release_dir" && BASE_URL="$base_url" npm run smoke)
echo "Deployed $UFOS_VERSION successfully."
