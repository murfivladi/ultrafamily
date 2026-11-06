#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

ARCHIVE="${1:-}"
: "${DATABASE_URL:?DATABASE_URL is required}"
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "Usage: restore.sh <backup.tar.gz|backup.tar.gz.age>" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ "$ARCHIVE" == *.age ]]; then
  command -v age >/dev/null || { echo "age is required for encrypted backups" >&2; exit 1; }
  : "${AGE_IDENTITY:?AGE_IDENTITY is required for encrypted backups}"
  age -d -i "$AGE_IDENTITY" -o "$WORK/backup.tar.gz" "$ARCHIVE"
else
  cp "$ARCHIVE" "$WORK/backup.tar.gz"
fi

tar -xzf "$WORK/backup.tar.gz" -C "$WORK"
BUNDLE="$WORK/bundle"
[[ -f "$BUNDLE/database.dump" && -f "$BUNDLE/SHA256SUMS" ]] || { echo "Invalid backup bundle" >&2; exit 1; }

(
  cd "$BUNDLE"
  sha256sum -c SHA256SUMS
) || { echo "Checksum verification failed" >&2; exit 1; }

echo "This will overwrite the database at DATABASE_URL and replace managed files."
read -r -p "Type RESTORE to continue: " CONFIRMATION
[[ "$CONFIRMATION" == "RESTORE" ]] || { echo "Restore cancelled"; exit 1; }

echo "Creating a pre-restore safety dump..."
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file="$ROOT/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"

echo "Restoring PostgreSQL..."
pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$BUNDLE/database.dump"

# Stage D: binary files live in STORAGE_DIR (relative paths are resolved
# against apps/api, where the API process runs). FILES_DIR overrides it.
STORAGE_PATH="${STORAGE_DIR:-.data/storage}"
[[ "$STORAGE_PATH" = /* ]] || STORAGE_PATH="$ROOT/apps/api/$STORAGE_PATH"
FILES_DIR="${FILES_DIR:-$STORAGE_PATH}"
if [[ -d "$FILES_DIR" ]]; then
  mv "$FILES_DIR" "${FILES_DIR}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$FILES_DIR"
tar -xzf "$BUNDLE/files.tar.gz" -C "$FILES_DIR"

echo "Restore completed. Verify /api/health, sign in, and review the audit log."
