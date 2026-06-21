# Triboon

Press play on anything. Triboon mounts the best healthy NZB from your usenet
provider and streams it instantly, seeking inside the archive while it is still
on the server, with continuous health protection and seamless auto-advance.
Self-hosted, Plex-polished, Stremio-style.

Current implementation: Phases 0-5 core are implemented in the Node/Web/Android
stack. The current verification baseline is `npm.cmd test` at 164/164 tests,
with focused IPTV, security, and NNTP scheduling coverage for the source-scoped
Live TV model and multi-user streaming capacity model. The server runtime stays
dependency-light: Node 24 LTS stdlib in `server/`, with approved external
binaries such as ffmpeg and yt-dlp.

## Quick Start

```bash
docker compose up --build
# open http://localhost:7777
```

1. Create the owner account.
2. Open Settings and add a usenet provider, a Newznab-compatible indexer, and a
   TMDB v3 key. Optional integrations include Wyzie subtitles, Trakt, music, and
   Live TV sources.
3. Browse the catalog and press Play. Search, rank, mount, and stream happen
   automatically.

Plain Node, without Docker:

```bash
node server/index.js
# open http://localhost:7777
```

ffmpeg is optional but strongly recommended. Without it, browsers that cannot
decode a source may need the external-player handoff.

## Android TV Debug Build

Use Android Studio's bundled JBR, the current Android SDK, and Gradle 9.5.1+.
The Android project uses Android Gradle Plugin 9.2.1, which requires Gradle
9.4.1+.

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
gradle -p android assembleDebug
```

The debug APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

If a current external Gradle is not installed, use the pinned fallback from
`android/`:

```powershell
.\gradlew.bat assembleDebug
```

Do not use an old local Gradle 8.x binary.

After Android shell changes, install and smoke-test the APK with:

```powershell
powershell -ExecutionPolicy Bypass -File bench\android-tv-smoke.ps1 -InstallApk -ColdStart -StartupDpad -NoScreenshot
```

The shell handles Android WebView renderer deaths with `onRenderProcessGone`:
it destroys the dead WebView, rebuilds it below setup/native-player overlays,
and reloads the last route instead of leaving Android's default crashed page.

## Unraid

The image is published to `ghcr.io/d1same/triboon:latest` on pushes that build
the release image.

- Template: use `unraid/triboon.xml` or its raw URL in Unraid's Docker template
  repository flow.
- Data path: map `/data` to `/mnt/user/appdata/triboon`.
- Optional media path: map a media share read-only to `/media` for local
  Libraries.
- Permissions: the container starts as root only to fix ownership, then drops to
  `PUID:PGID` with `UMASK`.
- Stable secret: set `TRIBOON_SECRET` so sessions and encrypted settings survive
  image rebuilds.

## How Play Works

```text
focus a title -> background prefetch of indexer search and top NZB
press Play    -> fan-out search/cache -> rank under quality cap
              -> fetch and mount the best release
              -> bounded health gate -> stream URL
first frame   -> HTTP Range bytes stream from usenet; seeking maps to articles
failure       -> auto-advance to the next ranked release at the same timestamp
```

Playback policy is always:

```text
source-fit -> direct play -> remux -> transcode
```

That means a 1080p-capped user should get a good 1080p source first, not a 4K
source that needs transcoding.

## Streaming Performance Model

Triboon manages VOD performance as a capacity model. Admins can enter each
usenet provider's real connection limit, expected simultaneous users, remote
users, server bandwidth, quality mix, buffer targets, and per-stream connection
windows in Settings -> Streaming performance.

The server combines multiple usenet providers without losing each account's own
cap, keeps a startup/seek reserve, and schedules NNTP work by priority:

```text
startup / seek -> playback -> health -> read-ahead -> background
```

Read-ahead grows when the server is idle and shrinks when more active streams
exist, so a large 4K stream should not block another user's first frame or seek.
The detailed contract is in `docs-streaming-performance.md`; player regression
contract `P14` in `docs-player-regression-map.md` tracks the code paths and
tests that protect it.

## Live TV Model

Live TV sources are first-class playlists. Admins can add multiple M3U or
Xtream sources, and each source owns its own channel cache, XMLTV cache, Xtream
guide cache, source-scoped channel ids, favorites cleanup, and delete behavior.

Important rules:

- Deleting a source removes its runtime cache, persisted source caches, and
  source-prefixed favorites/groups.
- Re-adding the same playlist starts fresh instead of reviving stale channel
  ids.
- Xtream disk caches do not store credential-bearing stream URLs; URLs are
  rebuilt from encrypted settings.
- Browser Live TV uses the server fMP4 remux path.
- Android TV uses native Media3/ExoPlayer first, with provider TS/HLS and then
  server remux fallback.
- Provider failures are logged with sanitized reasons and without credential
  URLs.

See `docs-architecture.md` and `docs-player-regression-map.md` for the full
source/cache/player map.

## What's Inside

| Module | Responsibility |
| --- | --- |
| `server/yenc.js` | yEnc decode and encode tests. |
| `server/nzb.js` | NZB parse, primary-file pick, password metadata. |
| `server/nntp.js` | NNTP client, priority lanes, parallel-connect pool, combined multi-provider failover. |
| `server/vfs.js` | Segment-map byte stream, playback/read-ahead priorities, triage. |
| `server/rar.js`, `server/zip.js` | RAR4/RAR5 and ZIP header parse to seekable extent maps. |
| `server/archive.js` | Container detection, volume ordering, archive mounts, verdict tags. |
| `server/newznab.js` | Indexer fan-out, hard per-indexer budget, dedupe. |
| `server/scoring.js` | TRaSH-style ranking plus Triboon streamability, language, health, and cap signals. |
| `server/pipeline.js` | Press-play search, rank, mount, health gate, auto-advance, cache. |
| `server/store.js` | Atomic JSON persistence and TTL verdict cache. |
| `server/auth.js` | scrypt auth, HMAC tokens, invites, Quick Connect, AES-256-GCM settings. |
| `server/tmdb.js`, `server/trakt.js` | TMDB proxy/cache, Trakt sync, scrobble outbox. |
| `server/opensubs.js` | Wyzie subtitle search/ranking/download helpers. |
| `server/transcode.js` | ffmpeg/ffprobe probe, remux, transcode, audio-track selection, subtitle extraction. |
| `server/index.js` | HTTP API, deny-by-default routes, Range streaming, Live TV source manager, static UI. |
| `web/index.html` | Entire app UI: setup/login, home/catalogs, libraries, Live TV, settings, player, D-pad nav. |
| `android/.../MainActivity.java` | Android TV WebView shell, key bridge, native Media3/ExoPlayer, PiP guide recovery. |

## Security

- Deny-by-default routing: every endpoint declares `public`, `user`, `admin`, or
  `stream` auth. A route-coverage test enforces this.
- Passwords use scrypt; session and stream URLs use HMAC-signed tokens.
- Stream tokens are scoped to one mount, file, channel, or local item.
- Provider, indexer, TMDB, Wyzie, Trakt, and IPTV credentials are encrypted at
  rest.
- Remote strings from indexers, IPTV, subtitles, and metadata are escaped before
  reaching the UI.
- Provider URLs with credentials must not be logged, cached in plain channel
  rows, committed, or printed in release notes.
- Login, profile PINs, invites, and Quick Connect are rate-limited.

## Verified

The current suite covers:

- yEnc, NZB parsing, primary-file picking.
- Store-RAR4/RAR5 and ZIP streaming, multi-volume archives, fuzzed seeks, HTTP
  Range semantics, suffix ranges, and cold-seek budget.
- Compressed/encrypted/7z detection with honest blocked verdicts.
- Multi-provider failover, combined provider capacity, bounded press-play health
  gate, and startup/seek priority over read-ahead.
- Title-safe source selection, scoring, caps, language policy, and manual
  source selection.
- Auth, settings encryption, invite/Quick Connect flows, route coverage, stream
  token binding, and security headers.
- TMDB, Trakt, watch state, Continue Watching, local libraries, subtitles,
  player D-pad behavior, Android native player contracts, and Live TV.
- IPTV source-scoped caches, source delete cleanup, clean re-add, large M3U
  stream parsing, XMLTV persistence, retune cleanup, and sanitized provider
  failures.

Run:

```bash
npm.cmd test
```

For Live TV work also run:

```bash
node --test test/iptv-cache.test.js
node --test test/security.test.js
```

For streaming-capacity work also run:

```bash
node --test test/e2e.test.js
node --test test/security.test.js
node --test test/phase2.test.js
```

## TV Controls

Arrow keys are the D-pad. Enter selects. Esc/Backspace goes back. Space toggles
play/pause. The focus ring is the cursor; backdrops follow the selected item.

## Roadmap Ahead

- Broader Android hardware QA for Shield, Onn, Fire TV, Chromecast, Google TV,
  and low-memory devices.
- Real multi-user playback stress testing that starts and seeks several 1080p
  and 4K streams together against a configured provider stack.
- Tauri desktop.
- par2 repair and compressed RAR improvements.
- MDBList and richer catalog rows.
- Intro/credit skip once playback and resume remain stable.
- Release automation polish: version bump, APK build, GitHub release, and
  Unraid update confirmation.

For legally obtained content only.
