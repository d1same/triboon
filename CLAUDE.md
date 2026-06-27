CLAUDE.md - Triboon

Triboon is a self-hosted, Plex-polished, Stremio-style streaming app. Pressing
play on any movie/show mounts the best healthy NZB from the admin's usenet
provider and streams it while unpacking, with continuous health protection.
Speed is the #1 product value. See `docs-architecture.md` for the current
architecture, data model, runtime map, and verify criteria.

## Working Process

Always follow the owner's method:

- Brainstorm + devil's advocate before building a feature: what could fail,
  what are we assuming, what would users hate, what is overcomplicated.
- Interview + capture when requirements are ambiguous. Ask short rounds of
  questions, keep a running brief, and play it back before building.
- Verify before trusting. Never call work done without running it.
- Before pushing or saying a fix is done, complete
  `VERIFY.md` and run `npm.cmd run verify:full`; IPTV, fast VOD startup, CC,
  Web Player, and Android ExoPlayer are hard gates when playback can be
  affected.
- Run `npm.cmd test` after engine or broad behavior changes on Windows.
- Add tests for new behavior before marking complete.
- For UI work, start `node server/index.js`, open `http://localhost:7777`, and
  visually check.
- Audit your own output against this file and `docs-architecture.md`.

## Locked Decisions

- Native clean-room rebuild of nzbdav + UsenetStreamer concepts.
- Server stack: Node 24 LTS, zero runtime npm dependencies in `server/`.
- Approved external binaries: ffmpeg for remux/transcode, yt-dlp for Music, and
  alass for automatic subtitle sync. alass is a single static binary (in the Docker
  image via gcompat + the v2.0.0 release) detected at runtime; the auto-sync feature
  is gated on its presence — absent on a box, the CC path is unchanged. It corrects
  offset + framerate drift using ffmpeg for audio. Triboon prefers Wyzie (unlimited,
  free) for the subtitle and auto-syncs only non-matched subs (release/hash matches
  are skipped) to avoid pulling audio unnecessarily. (ffsubsync was evaluated and
  rejected: Python+numpy/scipy/webrtcvad are painful on Alpine/musl.)
- Playback policy: source-fit, direct play, remux, transcode, in that order.
- Per-user quality caps are enforced at source selection first, transcoder
  second.
- Clients: one web UI in `web/index.html` for browser/TV spatial navigation,
  with Android TV as a Java WebView shell plus native Media3/ExoPlayer handoff.
- Product model: admin configures usenet, indexers, TMDB, subtitles, Trakt,
  Live TV, and libraries; users never see credentials.
- Health: bounded upfront gate plus background triage and auto-advance with
  timestamp resume. Never block playback on exhaustive checks.
- Streaming performance: provider connection limits, multi-provider capacity,
  startup/seek reserves, NNTP priority lanes, and adaptive read-ahead are owned
  by `docs-streaming-performance.md`. Do not revert to fixed connection-count
  tuning without updating that reference and tests.
- Catalogs: TMDB metadata, Trakt sync, built-in search/library. MDBList later.
- Design system: ink, magenta-to-coral gradient, amber accents, Sora display,
  Albert Sans body, JetBrains Mono badges, gradient focus ring, backdrop
  crossfade following focus.

## Commands

- `npm.cmd test` - full Node test suite (uses `--test-force-exit`; node:test otherwise hangs after
  the run completes). Current baseline: 249/249 tests.
- `npm run release:apk` - build + publish the Android APK to the GitHub release for the current tag.
  Defaults to debug signing; **`npm run release:apk -- -Release`** builds the proper keystore-signed
  release. (See the Hard Rules on signing.)
- `node server/index.js` - starts the app at `http://localhost:7777`.
- `docker compose up --build` - containerized app with ffmpeg and `/data`.
- Android build:
  - `JAVA_HOME=C:\Program Files\Android\Android Studio\jbr`
  - `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk`
  - Prefer current external Gradle 9.5.1+ with `gradle -p android assembleDebug`.
  - Use `android\gradlew.bat assembleDebug` as version-safe fallback.
  - Release builds are SIGNED with the project's dedicated release keystore via signing values
    kept outside git: `TRIBOON_RELEASE_STORE_FILE`, `TRIBOON_RELEASE_STORE_PASSWORD`,
    `TRIBOON_RELEASE_KEY_ALIAS`, `TRIBOON_RELEASE_KEY_PASSWORD` (in the owner's password manager +
    GitHub Actions secrets, incl. `TRIBOON_RELEASE_KEYSTORE_B64` for CI). See the signing Hard Rule.
  - Do not use `C:\Users\opencode\tools\gradle-8.10.2`.

Everything is configured in the web dashboard after first-run setup and is
encrypted at rest in `./data`. `TRIBOON_DATA` overrides the state directory.
`TRIBOON_SECRET` should be stable in production; otherwise the app generates a
secret into `./data`.

## Repo Map

- `server/yenc.js` - yEnc decode/encode.
- `server/nzb.js` - NZB parse, primary-file pick, password metadata.
- `server/nntp.js` - NNTP client, priority lanes, connection pool,
  combined multi-provider failover.
- `server/vfs.js` - segment map, playback/read-ahead priority, `readAt`,
  triage.
- `server/rar.js`, `server/zip.js`, `server/archive.js` - archive parsing,
  volume ordering, seekable extents, verdict tags.
- `server/newznab.js`, `server/scoring.js`, `server/pipeline.js` - indexer
  fan-out, ranking, title verification, health gate, auto-advance.
- `server/transcode.js` - ffmpeg/ffprobe probe, remux, transcode, tracks.
- `server/opensubs.js` - Wyzie subtitle search/ranking/download.
- `server/trakt.js` - Trakt OAuth, import/export, scrobble outbox.
- `server/index.js` - HTTP API, deny-by-default routes, Range streaming, Live
  TV source manager, local libraries, static UI.
- `web/index.html` - entire UI, including player, settings, Live TV, D-pad
  navigation, screensaver, music mini-player.
- `android/` - Android TV shell, native Media3/ExoPlayer, D-pad/back bridge,
  PiP guide recovery, APK build.
- `test/` - mock NNTP server, archive fixtures, phase tests, security tests,
  IPTV cache/source tests.
- `bench/` - provider/debug scripts and Android TV smoke/stress helpers.
- `docs-streaming-performance.md` - canonical multi-user VOD capacity,
  provider-connection, read-ahead, and health-gate reference.

## Roadmap And Current State

Current: Phases 0-5 core are implemented in the current Node/Web/Android stack,
with 186/186 tests passing on the latest verification pass.

- Phase 1 done: store-RAR4/RAR5 and ZIP streaming with seeking, multi-volume
  support, multi-provider failover, compressed/encrypted/7z detected and tagged.
- Phase 2 done: Newznab/Prowlarr/NZBHydra fan-out, scoring, verdict cache,
  title verification, press-play pipeline.
- Phase 3 done: auth, stream tokens, invites, Quick Connect, encrypted settings,
  TMDB proxy/cache, profiles, watch state.
- Phase 4 done: per-user caps at source selection, remux/transcode manager,
  web UI, player, Sources drawer, D-pad navigation.
- Phase 5 core in progress/done by area: Android native Media3/ExoPlayer
  playback, native Live TV, PiP guide, subtitles, Trakt sync, screensaver,
  local-library performance, source-scoped IPTV playlists, and owner-tunable
  multi-user streaming capacity.

Important current Live TV decision:

- IPTV providers are first-class sources/playlists. Each M3U or Xtream source
  owns its source id, channel cache, XMLTV cache, Xtream guide cache,
  source-scoped channel ids, favorites cleanup, and delete cleanup.
- Legacy single-playlist settings migrate through the compatibility `default`
  source only when no `settings.iptvSources[]` exists.
- Deleting a source must clear runtime caches, persisted source caches, and
  source-prefixed favorites/groups.
- Browser Live TV uses server fMP4 remux; Android TV uses ExoPlayer against
  provider TS/HLS first, then server remux fallback.

Important current VOD performance decision:

- Settings -> Streaming performance owns expected users, remote users, server
  bandwidth, quality mix, buffer targets, per-stream connection windows, and
  startup reserve.
- Usenet provider connection counts are saved per account up to the current
  server cap of 150; multiple providers combine by least-loaded healthy pool
  while keeping individual caps.
- NNTP priority order is startup/seek, playback, health, read-ahead, background.
  Health and read-ahead must never outrank bytes needed by the active player.
- Future buffering changes must preserve the same capacity contract and update
  `docs-streaming-performance.md` plus player regression contract `P14`.

Still open:

- Broader Android hardware QA matrix for Shield, Onn, Fire TV, Chromecast,
  Google TV, and low-memory devices.
- Real multi-user VOD stress runs across several 1080p and 4K starts/seeks.
- Tauri desktop.
- par2 repair and compressed RAR streaming improvements.
- MDBList and richer catalog rows.
- Intro/credit skip.
- Release automation polish.

## Hard Rules

- A phase is done only when tests pass and the owner has seen the demo.
- Never weaken or delete a failing test to make it pass. Fix the code or raise
  it with the owner.
- Releases always bump `package.json` and Android versionCode/versionName
  together; the tag is `vX.Y.Z`; the GitHub release carries versioned APKs
  (`triboon-tv-vX.Y.Z.apk`, `triboon-mobile-vX.Y.Z.apk`) plus stable aliases
  (`triboon-tv.apk`, `triboon-mobile.apk`). Stable aliases must be attached to
  the latest GitHub release so `/releases/latest/download/triboon-tv.apk` and
  `/releases/latest/download/triboon-mobile.apk` always resolve to the newest
  build.
- App signing (CRITICAL): there is ONE dedicated Android release keystore. ALWAYS sign release
  APKs with it — via CI (the `release-apk` job auto-builds + publishes on every `vX.Y.Z` tag using
  the `TRIBOON_RELEASE_*` repo secrets) or locally with `npm run release:apk -- -Release`. NEVER
  generate a new keystore or switch signing keys without explicit owner sign-off: a changed
  signature forces EVERY installed device to uninstall + reinstall. The keystore file + its
  passwords are the owner's secret (password manager + GitHub secrets) and must never be committed,
  logged, or written into docs. Do NOT ship debug-signed builds as releases.
- Security: deny-by-default routing; every new endpoint must declare auth and
  be covered by route-coverage tests.
- Credentials are encrypted at rest and must never be committed, logged, or
  written into docs.
- This is for legally obtained content; keep the project disclaimer intact.
