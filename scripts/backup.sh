#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
FILES_DIR="${FILES_DIR:-/var/lib/ufos/files}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="ufos-${STAMP}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$BACKUP_DIR" "$WORK/bundle"

echo "Creating consistent PostgreSQL dump..."
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$WORK/bundle/database.dump"

if [[ -d "$FILES_DIR" ]]; then
  echo "Archiving managed files..."
  tar -czf "$WORK/bundle/files.tar.gz" -C "$FILES_DIR" .
else
  echo "No managed file directory at $FILES_DIR; writing an empty placeholder archive."
  mkdir -p "$WORK/empty"
  tar -czf "$WORK/bundle/files.tar.gz" -C "$WORK/empty" .
fi

cat > "$WORK/bundle/manifest.json" <<EOF
{
  "product": "Ultra Family OS",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "version": "${APP_VERSION:-0.1.0-stage-a}",
  "databaseFormat": "pg_dump custom",
  "fileArchive": "files.tar.gz"
}
EOF

(
  cd "$WORK/bundle"
  sha256sum database.dump files.tar.gz manifest.json > SHA256SUMS
)

ARCHIVE="$BACKUP_DIR/$NAME.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" bundle
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"

if [[ -n "${AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null || { echo "AGE_RECIPIENT set but age is not installed" >&2; exit 1; }
  age -r "$AGE_RECIPIENT" -o "$ARCHIVE.age" "$ARCHIVE"
  shred -u "$ARCHIVE" 2>/dev/null || rm -f "$ARCHIVE"
  echo "Encrypted backup: $ARCHIVE.age"
else
  echo "Backup: $ARCHIVE"
  echo "WARNING: this backup is unencrypted. Copy it off the VPS before using real family data."
fi

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  command -v rclone >/dev/null || { echo "BACKUP_REMOTE set but rclone is not installed" >&2; exit 1; }
  rclone copyto "$ARCHIVE.age" "$BACKUP_REMOTE/$NAME.tar.gz.age" --config "${RCLONE_CONFIG:-$ROOT/.rclone.conf}" ||
    rclone copyto "$ARCHIVE" "$BACKUP_REMOTE/$NAME.tar.gz" --config "${RCLONE_CONFIG:-$ROOT/.rclone.conf}"
  echo "Off-VPS copy completed."
else
  echo "WARNING: BACKUP_REMOTE is unset. A same-VPS copy does not protect against VPS loss."
fi

if [[ "${BACKUP_RETENTION_DAYS:-30}" =~ ^[0-9]+$ ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ufos-*' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
fi
