#!/usr/bin/env bash
# Upload the CONTENTS of one FTP payload into the FTP account root (./).
# Merge automatically generated keys into the existing root .env.
# FTPS is required; no SSH or remote shell is used.
set -euo pipefail

: "${FTP_TARGET:?FTP_TARGET is required}"
: "${FTP_HOST:?FTP_HOST is required}"
: "${FTP_PORT:?FTP_PORT is required}"
: "${FTP_USER:?FTP_USER is required}"
: "${FTP_PASSWORD:?FTP_PASSWORD is required}"
: "${LOCAL_DIR:?LOCAL_DIR is required}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"

FTP_VERIFY_CERT="${FTP_VERIFY_CERT:-true}"
FTP_TLS_MODE="${FTP_TLS_MODE:-explicit}"
FTP_PARALLEL="${FTP_PARALLEL:-8}"
if [[ ! "$FTP_PARALLEL" =~ ^[0-9]+$ ]] || (( FTP_PARALLEL < 1 )); then
  echo 'FTP_PARALLEL must be a positive integer.' >&2
  exit 1
fi
if [[ "$FTP_TARGET" != 'backend' && "$FTP_TARGET" != 'frontend' ]]; then
  echo 'FTP_TARGET must be backend or frontend.' >&2
  exit 1
fi
if [[ "$FTP_TLS_MODE" != 'explicit' && "$FTP_TLS_MODE" != 'implicit' ]]; then
  echo 'FTP_TLS_MODE must be explicit or implicit.' >&2
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
if [[ "$FTP_USER" =~ [[:space:]] ]]; then
  echo 'FTP_USER contains leading, trailing or embedded whitespace.' >&2
  exit 1
fi
case "$FTP_PASSWORD" in
  *$'\r'* | *$'\n'*)
    echo 'FTP_PASSWORD contains a line break. Recreate the GitHub Secret without a trailing newline.' >&2
    exit 1
    ;;
esac
if [[ "$FTP_PASSWORD" =~ ^[[:space:]] || "$FTP_PASSWORD" =~ [[:space:]]$ ]]; then
  echo 'WARNING: FTP_PASSWORD begins or ends with whitespace. Recreate the GitHub Secret if this was accidental.' >&2
fi
if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "Local payload directory not found: $LOCAL_DIR" >&2
  exit 1
fi
LOCAL_DIR_ABS="$(cd "$LOCAL_DIR" && pwd)"

echo "FTPS diagnostics: target=$FTP_TARGET host=$FTP_HOST port=$FTP_PORT user=$FTP_USER tls=$FTP_TLS_MODE local_payload=$LOCAL_DIR_ABS remote_root=./ verify_cert=$FTP_VERIFY_CERT password_length=${#FTP_PASSWORD}"

if [[ "$FTP_TLS_MODE" == 'implicit' ]]; then
  FTP_SITE="ftps://$FTP_HOST"
else
  FTP_SITE="ftp://$FTP_HOST"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
EXISTING="$TMP/.env.existing"
GENERATED="$TMP/.env.generated"
MERGED="$TMP/.env.merged"
LISTING="$TMP/listing.txt"
MANIFEST_NAME='.ufos-deploy-manifest'
OLD_MANIFEST="$TMP/manifest.old"
NEW_MANIFEST="$TMP/manifest.new"

node "$ROOT/scripts/ftp-env.mjs" > "$GENERATED"
chmod 600 "$GENERATED"

lftp_common() {
  cat <<EOF
set cmd:fail-exit yes
set ftp:list-options -a
set ftp:passive-mode true
set ssl:verify-certificate $FTP_VERIFY_CERT
set net:max-retries 3
set net:timeout 20
set xfer:clobber true
set mirror:set-permissions no
set ftp:use-site-chmod no
set ftp:use-site-utime no
set ftp:use-site-utime2 no
set ftp:use-mdtm-overloaded no
EOF
  if [[ "$FTP_TLS_MODE" == 'explicit' ]]; then
    printf '%s\n' 'set ftp:ssl-force true' 'set ftp:ssl-protect-data true' 'set ftp:ssl-auth TLS'
  else
    printf '%s\n' 'set ftp:ssl-protect-data true'
  fi
}

# Hidden paths matter here: .next/ and .env.example are part of the payload.
# ftp:list-options -a makes lftp see dot-directories on restricted FTP servers.
# Shared-hosting FTP often disables SITE/MFF entirely. Keep server-side
# default permissions and timestamps instead of trying chmod over FTP.
# LFTP_PASSWORD alone is ignored by lftp: --env-password is mandatory.
# This keeps the password out of the command line and process listing.
run_lftp() {
  LFTP_PASSWORD="$FTP_PASSWORD" lftp --env-password -u "$FTP_USER" -p "$FTP_PORT" "$FTP_SITE"
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

if [[ "${FTP_FULL_UPLOAD:-false}" != 'true' ]] && awk '{print $NF}' "$LISTING" | grep -Fxq "$MANIFEST_NAME"; then
  echo 'Remote deploy manifest found; downloading it for an incremental upload...'
  if { lftp_common; printf '%s\n' "get -O \"$TMP\" $MANIFEST_NAME" 'bye'; } | run_lftp \
    && [[ -f "$TMP/$MANIFEST_NAME" ]]; then
    mv "$TMP/$MANIFEST_NAME" "$OLD_MANIFEST"
  else
    echo 'WARNING: could not download the deploy manifest; falling back to a full upload.' >&2
    rm -f "$OLD_MANIFEST"
  fi
fi

ENV_EXISTING="$EXISTING" ENV_GENERATED="$GENERATED" ENV_MERGED="$MERGED" \
  node "$ROOT/scripts/merge-env.mjs"
chmod 600 "$MERGED"
if grep -Eq '^API_PROXY_ORIGIN=https://api\.family\.vladislavb\.qzz\.io\s*$' "$MERGED"; then
  echo "WARNING: frontend .env still uses the external HTTPS API origin; edit it to http://127.0.0.1:25031 and rerun ftp.yml." >&2
fi
if [[ "$FTP_TARGET" == 'backend' ]] && grep -Eq '^API_PORT=3001\s*$' "$MERGED"; then
  echo 'WARNING: backend .env still uses API_PORT=3001; edit the existing line to API_PORT=25031.' >&2
fi

# The frontend payload is a Next.js standalone build: its node_modules is a
# traced runtime subset and MUST be uploaded. The backend payload installs
# dependencies on the server, so its node_modules stays excluded.
# Keep the cache exclusion specific (.next/cache): a bare `cache/` glob would
# also drop node_modules/webpack/lib/cache from the standalone frontend.
MIRROR_EXCLUDES='--exclude-glob .env --exclude-glob .env.local --exclude-glob .env.*.local --exclude-glob .git/ --exclude-glob .next/cache/ --exclude-glob *.pack'
if [[ "$FTP_TARGET" == 'backend' ]]; then
  MIRROR_EXCLUDES+=" --exclude-glob node_modules/"
fi
MIRROR_EXCLUDES+=" --exclude-glob $MANIFEST_NAME"

# Incremental upload. Every file is a separate FTPS data connection with its
# own TLS handshake, so re-sending ~2000 unchanged node_modules files took
# longer than the job timeout. A manifest of SHA-256 hashes is stored in the
# FTP root; the next deploy downloads it and uploads only files whose content
# changed. The manifest is written LAST, so an interrupted upload leaves the
# previous manifest and the next run re-sends everything that was pending.
# FTP_FULL_UPLOAD=true (workflow input) ignores the manifest and re-sends all.
build_manifest() {
  local find_args=(. -type d \( -name .git -o -path '*/.next/cache' )
  if [[ "$FTP_TARGET" == 'backend' ]]; then
    find_args+=(-o -name node_modules)
  fi
  find_args+=(\) -prune -o -type f
    ! -name .env ! -name .env.local ! -name '.env.*.local' ! -name '*.pack'
    ! -path "./$MANIFEST_NAME" -print0)
  (cd "$LOCAL_DIR_ABS" && find "${find_args[@]}" | LC_ALL=C sort -z | xargs -0 -r sha256sum --)
}
build_manifest > "$NEW_MANIFEST"
TOTAL_FILES="$(wc -l < "$NEW_MANIFEST" | tr -d ' ')"

UPLOAD_MODE=full
if [[ "${FTP_FULL_UPLOAD:-false}" == 'true' ]]; then
  echo 'FTP_FULL_UPLOAD=true: ignoring the remote manifest, uploading every file.'
elif [[ -s "$OLD_MANIFEST" ]]; then
  UPLOAD_MODE=incremental
else
  echo 'No remote deploy manifest found: first deploy uploads every file.'
fi

UPLOAD_SOURCE="$LOCAL_DIR_ABS"
MIRROR_FLAGS=''
if [[ "$UPLOAD_MODE" == 'incremental' ]]; then
  CHANGED="$TMP/changed.txt"
  # Lines are "<sha256>  ./path"; a line absent from the old manifest means
  # a new or modified file.
  LC_ALL=C awk 'NR==FNR { seen[$0] = 1; next } !($0 in seen) { print substr($0, 67) }' \
    "$OLD_MANIFEST" "$NEW_MANIFEST" > "$CHANGED"
  CHANGED_COUNT="$(wc -l < "$CHANGED" | tr -d ' ')"
  echo "Incremental upload: $CHANGED_COUNT of $TOTAL_FILES files changed since the last deploy."
  STAGE="$TMP/stage"
  mkdir -p "$STAGE"
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    mkdir -p "$STAGE/$(dirname "$rel")"
    cp -p "$LOCAL_DIR_ABS/$rel" "$STAGE/$rel"
  done < "$CHANGED"
  UPLOAD_SOURCE="$STAGE"
  # Content is known to differ: do not let size/mtime comparison skip it.
  MIRROR_FLAGS='--transfer-all'
else
  echo "Full upload: $TOTAL_FILES files."
fi

# lftp's mirror with an explicit source directory can append that directory
# name to the remote target. Instead, enter the payload with lcd and call
# mirror -R without source/target: current local dir -> current remote dir.
# Remote-only files are never deleted (no --delete), same as before.
echo "Uploading contents of $UPLOAD_SOURCE into FTP root ./ ..."
{
  lftp_common
  printf '%s\n' 'cd ./' "lcd \"$UPLOAD_SOURCE\""
  if [[ "$FTP_TARGET" == 'frontend' ]]; then
    # Runtime page cache written by older builds (isrFlushToDisk). Next serves
    # it in preference to the uploaded build, so a stale copy hides releases.
    printf '%s\n' 'rm -r -f apps/web/.next/server/app/route-cache'
  fi
  if [[ "$UPLOAD_MODE" == 'full' || -n "$(find "$UPLOAD_SOURCE" -type f -print -quit)" ]]; then
    printf '%s\n' "mirror -R --no-perms --no-umask --parallel=$FTP_PARALLEL $MIRROR_FLAGS --verbose $MIRROR_EXCLUDES"
  fi
  printf '%s\n' \
    "put \"$MERGED\" -o .env" \
    "put \"$NEW_MANIFEST\" -o $MANIFEST_NAME" \
    'bye'
} | run_lftp

echo "FTP upload completed for $FTP_TARGET release $RELEASE_VERSION ($UPLOAD_MODE)."
