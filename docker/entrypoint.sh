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

  mkdir -p "${TRIBOON_DATA:-/data}"
  # /data holds small JSON state + cached thumbnails — a recursive chown stays cheap and
  # guarantees the appdata share ends up PUID:PGID-owned regardless of how it was created.
  chown -R "$PUID:$PGID" "${TRIBOON_DATA:-/data}"

  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
