FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
WORKDIR /app

ARG YTDLP_VERSION=2026.07.04
ARG YTDLP_SHA256=495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd
ARG ALASS_VERSION=v2.0.0
ARG ALASS_SHA256=7bd0b9ae7e035d3ba940eacffb21243614df36231d47f21f0b4ce42001ab7fcd

# ffmpeg sidecar (remux/transcode path) + su-exec for the PUID/PGID privilege drop +
# yt-dlp for Music playback + ytmusicapi for faster YouTube Music catalog/search metadata.
# yt-dlp is the official zipapp (needs python3). The downloaded binaries are pinned and
# SHA-256 verified so a rebuild cannot silently consume a changed upstream artifact.
# gcompat lets the prebuilt (glibc) alass binary run on Alpine/musl — verified it executes.
# alass ("Automatic Language-Agnostic Subtitle Synchronization") is one small static binary that
# corrects subtitle offset AND framerate drift, using ffmpeg for the audio (no Python/numpy).
RUN apk add --no-cache ffmpeg su-exec python3 py3-pip gcompat \
 && python3 -m pip install --no-cache-dir --break-system-packages ytmusicapi==1.12.1 \
 && wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
 && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
 && chmod +x /usr/local/bin/yt-dlp \
 && /usr/local/bin/yt-dlp --version \
 && wget -qO /usr/local/bin/alass "https://github.com/kaegi/alass/releases/download/${ALASS_VERSION}/alass-linux64" \
 && echo "${ALASS_SHA256}  /usr/local/bin/alass" | sha256sum -c - \
 && chmod +x /usr/local/bin/alass

COPY package.json ./
COPY LICENSE THIRD-PARTY-NOTICES.md ./
COPY server ./server
COPY web ./web
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Persistent state (users, settings, watch, verdict cache) lives here — mount a volume.
# Ownership is taken at runtime by the entrypoint (PUID/PGID, Unraid-style; default 99:100).
RUN mkdir -p /data
ENV TRIBOON_DATA=/data
ENV PORT=7777
EXPOSE 7777

# Container health: the public /api/server endpoint needs no auth.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:7777/api/server >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
