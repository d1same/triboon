#!/bin/sh
# Unraid-style permission handling: the container starts as root, creates/locates a user
# matching PUID:PGID (Unraid default 99:100 = nobody:users), takes ownership of /data, and
# drops privileges before launching the server. Running with --user (non-root) skips all of
# this and just execs — both styles work.
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"

if [ "$(id -u)" = "0" ]; then
  umask "$UMASK"

  if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" triboon
  fi
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    adduser -D -H -G "$(getent group "$PGID" | cut -d: -f1)" -u "$PUID" -s /bin/sh triboon
  fi

  DATA_DIR="${TRIBOON_DATA:-/data}"
  mkdir -p "$DATA_DIR"
  # Only recursively chown when top-level ownership mismatches so large segment caches don't stall boot.
  if [ "$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || echo '')" != "$PUID:$PGID" ]; then
    chown -R "$PUID:$PGID" "$DATA_DIR" || true
  fi

  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
