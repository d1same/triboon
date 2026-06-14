FROM node:24-alpine
WORKDIR /app

# ffmpeg sidecar (remux/transcode path) + su-exec for the PUID/PGID privilege drop +
# yt-dlp for Music (YouTube Music). yt-dlp is the official zipapp (needs python3); pulling it
# at build time keeps it current, and a rebuild refreshes it when YouTube changes things.
RUN apk add --no-cache ffmpeg su-exec python3 \
 && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && /usr/local/bin/yt-dlp --version

COPY package.json ./
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
