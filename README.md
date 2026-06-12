# Triboon

Press play on anything. Triboon mounts the best healthy NZB from your usenet provider and
streams it instantly — seeking *inside* the RAR while it's still on the server, with continuous
health protection and seamless auto-advance. Self-hosted, Plex-polished, Stremio-style.

**Phases 0–4 implemented & verified** — a usable multi-user product. 113/113 tests, runs in
Docker with ffmpeg, verified end-to-end against real providers and indexers.
Zero runtime npm dependencies — Node 20 stdlib only.

## Quick start (Docker)

```bash
docker compose up --build          # or: docker run … ghcr.io/d1same/triboon:latest
# open http://localhost:7777
```

1. **Create the owner account** (first-run setup).
2. **Settings** → add your **usenet provider**, a **newznab indexer** (nzbgeek / NZBHydra /
   Prowlarr), and a **TMDB** v3 key. All credentials are encrypted at rest in the `/data` volume.
3. Browse the catalog and **press Play.** Search → rank → mount → stream, automatically.

Plain Node (no Docker): `node server/index.js` then open http://localhost:7777. (ffmpeg remux
is optional — without it, browsers that can't decode MKV get a one-click "open in VLC" handoff.)

## Unraid

The image is published to **`ghcr.io/d1same/triboon:latest`** (amd64 + arm64) on every push.

- **Template:** *Docker → Add Container → Template repositories* — or apply
  [`unraid/triboon.xml`](unraid/triboon.xml) directly (raw URL works in "Add Container").
- **Paths:** `/data` → `/mnt/user/appdata/triboon` (state, encrypted settings). Optionally map
  a media share read-only to `/media` for the local Libraries feature.
- **Permissions:** the container starts as root only to fix ownership, then drops to
  `PUID:PGID` (default **99:100** = `nobody:users`, the Unraid convention) with `UMASK` 022 —
  appdata files stay editable from the array like any other app.
- **Stable secret:** set `TRIBOON_SECRET` (64 hex chars) so sessions and encrypted settings
  survive image rebuilds; otherwise a key is generated into `/data` on first run.

## How a press of Play works

```
focus a title   → server prefetches the indexer search + top NZB in the background
press Play      → fan-out search (cached) → TRaSH-style rank within your quality cap
                → fetch + mount the best release (segment map, no download)
                → 500ms bounded health gate (never blocks) → stream URL
first frame     → HTTP Range bytes stream straight from usenet; seeking maps to articles
mid-stream dies → auto-advance to the next ranked release, resumed at your timestamp
```

Press-play is judged on time-to-first-frame. Measured against real Easynews + nzbgeek: a
browsed-then-played title reaches a stream URL in **~2.8s cold**, **~4ms on replay** (live mount
reuse). Scoring is tuned for instant start, not archival — a clean WEB-DL is the default pick;
the 60 GB remux is still one tap away in the Sources drawer.

## What's inside (clean-room, zero deps)

| Module | Responsibility |
|---|---|
| `server/yenc.js` | yEnc decode (hot path) + encode |
| `server/nzb.js` | NZB parse, primary-file pick, password meta |
| `server/nntp.js` | NNTP client, parallel-connect pool, multi-provider failover |
| `server/vfs.js` | segment-map byte stream, read-ahead, triage |
| `server/rar.js` · `zip.js` | RAR4/RAR5 + ZIP header parse → seekable extent map |
| `server/archive.js` | container detection, volume ordering, archive mounts, verdict tags |
| `server/newznab.js` | indexer fan-out (hard per-indexer budget), dedupe |
| `server/scoring.js` | TRaSH-Guides-style ranking + Triboon streamability/health signals |
| `server/pipeline.js` | press-play: search → rank → mount → gate → auto-advance + caching |
| `server/store.js` | atomic JSON persistence + TTL verdict cache |
| `server/auth.js` | scrypt + HMAC tokens, invites, Quick Connect, AES-256-GCM settings |
| `server/tmdb.js` | server-side TMDB proxy + cache |
| `server/transcode.js` | ffmpeg/ffprobe detect, **HW-accel H.264 transcode ladder** (NVENC/QSV/AMF/VideoToolbox/VAAPI→libx264, HDR→SDR tone-map, quality rungs), remux w/ audio-track selection, track probing, subtitle→WebVTT extraction (source-fit → direct → remux → transcode) |
| `server/index.js` | HTTP API, deny-by-default route table, Range streaming, static UI |
| `web/index.html` | the entire Plex-style UI (single file, TV D-pad spatial nav): push-on-hover sidebar (Search-first menu, user-reorderable/hideable via **Preferences**, + admin-curated **custom libraries** with folder scan), home with poster cover-art rows (+ backdrop Continue Watching), **Discover**, **Movies/TV** pages with genre/sort + infinite scroll, **Calendar**, **Watchlist**, **voice search**, **Live TV** (M3U or **Xtream Codes**, channel groups + logos, per-user **favorites**, **now/next guide** from Xtream EPG or XMLTV), detail pages (directors/writers, cast → person pages, seasons → episode strip, related row), trailer modal, player (CC/audio/quality/volume, up-next), tabbed admin settings |

## Security

- Deny-by-default routing: every endpoint declares its auth level (`public`/`user`/`admin`/
  `stream`); unknown routes 404. A route-coverage test enforces the declaration.
- scrypt password hashing, HMAC-signed session tokens, separate expiring **stream tokens**
  (6h, **bound to a single mount/file/channel**) so VLC/ExoPlayer/`<video>` can play a URL
  without a header — a leaked URL streams that one thing, nothing else.
- **Rate limiting** on login, profile-PIN verify, invite accept, and Quick Connect (429 +
  Retry-After) — a 4-digit parental PIN cannot be brute-forced.
- All remote strings (release names, IPTV channel data, TMDB fields) HTML-escaped in the UI;
  CSP + nosniff + frame headers on the app shell; fetched playlists/guides/NZBs size-capped.
- Provider/indexer/TMDB credentials encrypted at rest (AES-256-GCM, key from `TRIBOON_SECRET`).
- Single-use expiring invites; Quick Connect codes (6-digit, 60s TTL, approve-from-phone).
- Graceful SIGTERM shutdown (Docker) + a 5-minute housekeeping sweep that evicts idle mounts.

## Verified (113/113, `npm test`)

- yEnc byte-exactness + CRC; NZB parsing; primary-file picking
- Streaming **store-RAR4/RAR5 (single + multi-volume) and ZIP**, byte-exact, with fuzzed seeks —
  the hand-rolled store fixtures are validated against **real unrar** in Docker
- Compressed/encrypted/7z detection → honest `streamable:false` + verdict tags
- Multi-provider failover; HTTP Range (`206`, suffix ranges, `416`); <250ms cold-seek budget
- TRaSH-style scoring (caps, source/group tiers, streamability/health, press-play size shaping)
- Indexer fan-out with per-indexer timeout; press-play pipeline + auto-advance + verdict cache
- Deny-by-default route coverage; auth flows; settings-encrypted-at-rest; TMDB proxy + cache;
  per-user watch state; Quick Connect; password change
- Playback decision logic + ffmpeg remux lifecycle (runs live in the Docker image)
- Full suite also runs **inside the production container** on Alpine with ffmpeg present

## TV controls

Arrow keys = D-pad · Enter = select · Esc/Backspace = back · Space = play/pause. The gradient
focus ring is the cursor; the backdrop crossfades to follow focus.

## Roadmap ahead

ExoPlayer-native Android playback (true DDP/Atmos passthrough) · ffmpeg HW-accel ladder +
HDR tone-map · Trakt rows · Tauri desktop · par2 repair · MDBList. See `docs-architecture.md`.

---
*For legally obtained content only.*
