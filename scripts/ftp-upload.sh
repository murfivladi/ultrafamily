#!/usr/bin/env bash
# Upload one FTP payload to ./ and merge automatically generated keys into
# the existing root .env. FTPS is required; no SSH or remote shell is used.
set -euo pipefail

: "${FTP_TARGET:?FTP_TARGET is required}"
: "${FTP_HOST:?FTP_HOST is required}"
: "${FTP_PORT:?FTP_PORT is required}"
: "${FTP_USER:?FTP_USER is required}"
: "${FTP_PASSWORD:?FTP_PASSWORD is required}"
: "${LOCAL_DIR:?LOCAL_DIR is required}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"

FTP_VERIFY_CERT="${FTP_VERIFY_CERT:-true}"
if [[ "$FTP_TARGET" != 'backend' && "$FTP_TARGET" != 'frontend' ]]; then
  echo 'FTP_TARGET must be backend or frontend.' >&2
  exit 1
fi
if [[ "$FTP_PORT" != [0-9]* ]]; then
  echo 'FTP_PORT must be numeric.' >&2
  exit 1
fi
if [[ "$FTP_HOST" != [A-Za-z0-9._-]* ]]; then
  echo 'FTP_HOST must be a bare hostname, not a URL.' >&2
  exit 1
fi
if [[ "$FTP_VERIFY_CERT" != 'true' && "$FTP_VERIFY_CERT" != 'false' ]]; then
  echo 'FTP_VERIFY_CERT must be true or false.' >&2
  exit 1
fi
if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "Local payload directory not found: $LOCAL_DIR" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
EXISTING="$TMP/.env.existing"
GENERATED="$TMP/.env.generated"
MERGED="$TMP/.env.merged"
LISTING="$TMP/listing.txt"

node "$ROOT/scripts/ftp-env.mjs" > "$GENERATED"
chmod 600 "$GENERATED"

lftp_common() {
  cat <<EOF
set cmd:fail-exit yes
set ftp:ssl-force true
set ftp:ssl-protect-data true
set ftp:passive-mode true
set ssl:verify-certificate $FTP_VERIFY_CERT
set net:max-retries 3
set net:timeout 20
set xfer:clobber true
EOF
}

run_lftp() {
  LFTP_PASSWORD="$FTP_PASSWORD" lftp -u "$FTP_USER" -p "$FTP_PORT" "ftp://$FTP_HOST"
}

echo "Checking FTPS connection and remote root listing for $FTP_TARGET..."
if ! { lftp_common; printf '%s\n' 'ls' 'bye'; } | run_lftp > "$LISTING" 2>&1; then
  echo 'FTPS connection or remote root listing failed.' >&2
  cat "$LISTING" >&2
  exit 1
fi

if awk '{print $NF}' "$LISTING" | grep -Fxq '.env'; then
  echo 'Existing .env found; downloading it before the merge...'
  if ! { lftp_common; printf '%s\n' "get -O \"$TMP\" .env" 'bye'; } | run_lftp; then
    echo 'Could not download the listed .env; refusing to overwrite it.' >&2
    exit 1
  fi
  if [[ ! -f "$TMP/.env" ]]; then
    echo 'Existing .env was listed but not downloaded; refusing to overwrite it.' >&2
    exit 1
  fi
  mv "$TMP/.env" "$EXISTING"
  echo 'Existing .env preserved; only missing generated keys will be added.'
else
  echo 'No existing .env found; a new one will be created.'
  rm -f "$EXISTING"
fi

ENV_EXISTING="$EXISTING" ENV_GENERATED="$GENERATED" ENV_MERGED="$MERGED" \
  node "$ROOT/scripts/merge-env.mjs"
chmod 600 "$MERGED"

echo "Uploading $FTP_TARGET payload to ./ ..."
{
  lftp_common
  printf '%s\n' \
    "mirror -R --parallel=3 --verbose --exclude .env --exclude .env.local --exclude .env.*.local --exclude node_modules/ --exclude .git/ \"$LOCAL_DIR\" ./" \
    "put \"$MERGED\" -o .env" \
    'bye'
} | run_lftp

echo "FTP upload completed for $FTP_TARGET release $RELEASE_VERSION."
