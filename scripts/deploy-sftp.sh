#!/usr/bin/env bash
set -euo pipefail

# Uploads a versioned, prebuilt release archive. Switching `current` is a separate
# explicit step so a partially uploaded release can never become active.
ARCHIVE="${1:-}"
: "${SFTP_HOST:?SFTP_HOST is required (prefer SFTP over plain FTP)}"
: "${SFTP_USER:?SFTP_USER is required}"
: "${SFTP_REMOTE_DIR:?SFTP_REMOTE_DIR is required}"
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo "Usage: deploy-sftp.sh <release.tar.gz>" >&2; exit 1; }
command -v lftp >/dev/null || { echo "lftp is required" >&2; exit 1; }
[[ -f "$ARCHIVE.sha256" ]] || { echo "Missing checksum: $ARCHIVE.sha256" >&2; exit 1; }

NAME="$(basename "$ARCHIVE")"
CHECKSUM="$(basename "$ARCHIVE.sha256")"
PORT="${SFTP_PORT:-22}"

# Provide the password through LFTP_PASSWORD rather than a command-line argument.
LFTP_PASSWORD="${LFTP_PASSWORD:-}" lftp -u "$SFTP_USER" -p "$PORT" "sftp://$SFTP_HOST" <<EOF
set sftp:auto-confirm yes
set net:max-retries 2
set net:timeout 20
mkdir -p "$SFTP_REMOTE_DIR/releases"
cd "$SFTP_REMOTE_DIR/releases"
put "$ARCHIVE" -o "$NAME.part"
mv "$NAME.part" "$NAME"
put "$ARCHIVE.sha256" -o "$CHECKSUM.part"
mv "$CHECKSUM.part" "$CHECKSUM"
bye
EOF

echo "Uploaded $NAME. Verify its checksum on the server, unpack into a versioned release directory,"
echo "run migrations/backup, then switch the current symlink. Never upload .env or the local database."
