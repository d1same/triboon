# Triboon Architecture And Runtime Map

Triboon is a self-hosted streaming app: one admin configures providers, indexers,
metadata, subtitles, Live TV, and users; everyone else joins with normal app
accounts and presses Play. Speed is the product value. The server should pick the
best playable source quickly, direct play whenever possible, and only remux or
transcode when the device cannot play the original stream.

This file is the current architecture reference. If code moves, routes change,
or a cache gets a new owner, update this file and `docs-player-regression-map.md`
in the same change. For usenet capacity, provider connections, read-ahead, and
multi-user startup/seek behavior, `docs-streaming-performance.md` is the
canonical reference.

## Current Snapshot

- Server: Node 24 LTS, stdlib runtime, no runtime npm dependencies in `server/`.
- UI: `web/index.html`, one web app with TV D-pad navigation and browser support.
- Android TV: Java WebView shell with native Media3/ExoPlayer for video and Live TV.
- Data: atomic JSON store in `TRIBOON_DATA`, encrypted settings through
  `server/auth.js` `SecureSettings`, and a local-media-only SQLite catalog
  (`library.sqlite`) for large attached folders.
- Playback order: source-fit, direct play, remux, transcode.
- Security: deny-by-default route table in `server/index.js`; every endpoint must
  declare `public`, `user`, `admin`, or `stream` auth and be covered by tests.
- Current verification baseline after the playback startup/read-ahead pass: full
  `npm.cmd test` covers 233 tests; focused IPTV, security, Android native
  player, Music, subtitle, source-warmup, and NNTP priority tests cover the
  current source model, route table, device bridge, process queue, startup
  preparation, and capacity scheduling.

## System Map

```mermaid
flowchart LR
  subgraph Clients
    Web["Web app\nweb/index.html"]
    Android["Android TV shell\nMainActivity.java + ExoPlayer"]
    VLC["External player\nsigned stream URL"]
  end

  subgraph Server["Node server/index.js"]
    Routes["Deny-by-default routes"]
    Auth["Auth, users, profiles,\nQuick Connect, stream tokens"]
    Catalog["TMDB + Trakt + watch state"]
    Pipeline["Search, scoring,\nmount, health gate"]
    Stream["NNTP/RAR/VFS stream engine"]
    Transcode["ffmpeg remux/transcode"]
    Subs["Wyzie subtitles"]
    IPTV["Live TV source manager"]
  end

  Store["Atomic JSON store\nsettings encrypted at rest"]
  LocalDb["Local media SQLite catalog\nlibrary.sqlite"]
  Providers["Usenet providers\nNewznab indexers\nTMDB/Trakt/Wyzie\nM3U/Xtream/XMLTV"]

  Web --> Routes
  Android --> Routes
  VLC --> Routes
  Routes --> Auth
  Routes --> Catalog
  Routes --> Pipeline
  Routes --> Subs
  Routes --> IPTV
  Pipeline --> Stream
  Pipeline --> Transcode
  IPTV --> Transcode
  Auth --> Store
  Catalog --> Store
  Pipeline --> Store
  IPTV --> Store
  Routes --> LocalDb
  Stream --> Providers
  Catalog --> Providers
  Subs --> Providers
  IPTV --> Providers
```

## Core Ownership

| Area | Owner files | Notes |
| --- | --- | --- |
| Auth and encrypted settings | `server/auth.js`, `server/index.js` | Users, invites, Quick Connect, admin TOTP 2FA, HKDF-separated HMAC session/stream tokens, session epochs, AES-256-GCM settings. |
| Persistence | `server/store.js`, `server/library-db.js` | JSON remains the app state store. `library.sqlite` indexes scanned local-media items only, so 80k+ attached files can page and look up without loading every item into the UI. |
| Metadata | `server/tmdb.js`, `server/trakt.js`, `server/index.js` | TMDB proxy/cache, encrypted Trakt link tokens, Trakt sync/outbox, profile watch state. |
| Search and source ranking | `server/newznab.js`, `server/scoring.js`, `server/pipeline.js` | Title-safe matching, quality caps at source selection, health-aware ranking. |
| Streaming engine | `server/nzb.js`, `server/nntp.js`, `server/vfs.js`, `server/rar.js`, `server/zip.js`, `server/archive.js`, `docs-streaming-performance.md` | Clean-room NZB mount, article reads, RAR/ZIP extent maps, Range streaming, provider capacity, priority lanes, adaptive read-ahead. |
| Playback decision | `server/transcode.js`, `server/index.js`, `web/index.html`, `android/.../MainActivity.java` | Source-fit, direct, remux, transcode; Android native caps feed server policy. |
| Subtitles | `server/opensubs.js`, `server/index.js`, `web/index.html`, `MainActivity.java` | Wyzie search/download, release/file hints, WebVTT, web/native display timelines; built-in extraction is opt-in. |
| Local libraries | `server/index.js`, `server/library-db.js`, `web/index.html` | Folder scan, SQLite-backed bounded pages/lookups, local playback, local artwork. |
| Live TV | `server/index.js`, `web/index.html`, `MainActivity.java` | Source-scoped shared M3U/Xtream/XMLTV, web remux path, Android native Exo path, and Android device-local personal IPTV. |
| Music Home | `server/ytmusic.js`, `server/index.js`, `web/index.html` | YouTube Music search/home/charts via optional `ytmusicapi` catalog helper, Google device-code account linking with encrypted per-user tokens, bounded `yt-dlp` playback resolver, tokenized audio proxy, web mini-player, and no ExoPlayer handoff for audio yet. |
| Continue Watching | `docs-continue-watching.md`, `server/index.js`, `web/index.html` | Canonical movie/show identity, resume state, quality carry-forward, next-up, and D-pad focus after row actions. |
| Android shell | `android/app/src/main/java/app/triboon/tv/MainActivity.java` | WebView bridge, D-pad/back handling, native video/Live TV, PiP guide recovery, APK update links. |

## Press Play Pipeline

```mermaid
sequenceDiagram
  participant UI as Web/Android UI
  participant API as /api/play
  participant Prep as /api/search + /api/prepare
  participant Search as Pipeline search
  participant Rank as Scoring
  participant Mount as NZB mount/VFS
  participant Player as Web player or ExoPlayer

  UI->>Prep: detail focus warms source search
  Prep->>Search: cached or fresh indexer fan-out
  Prep->>Mount: prepare first viable ranked source in background
  UI->>API: title, profile, caps, optional resume
  API->>Search: reuse cached search/prepared mount when present
  Search->>Rank: title-verified release rows
  Rank->>API: best source under user/device cap
  API->>Mount: fetch NZB, parse, build segment map if not prepared
  API->>API: bounded health gate
  API-->>UI: direct/remux/transcode/native ladder
  UI->>Player: start at resume position
  Player->>API: watch progress / source failover
```

Rules that must not drift:

- User quality caps are enforced before transcoding, at source selection.
- The Sources drawer and the Play button share the same title verification and
  ranking path; manual source selection must mount the chosen release.
- Detail-page source warmup is a startup-speed feature. Title-only warmup
  results can feed the later exact-id Play request. When the Play target is
  stable, `/api/prepare` may mount the first viable source from a small capped
  slice of the ranked list in the background without creating a play session or
  stream URL. Play must reuse or join that prepared/in-flight mount and
  in-flight NZB prefetch instead of repeating source finding, first-article
  probe, mount, or health-gate work.
- Android capability claims come from the native bridge, not WebView guesses.
  Video caps are decoder-based, but HD-audio passthrough caps must come from
  the active HDMI/ARC/eARC audio output encodings. TrueHD/Atmos/DTS-HD releases
  are preferred and direct-played only when the current native device reports
  matching passthrough support; budget devices and browsers keep the safer
  WEB-sized/remux-to-AAC path. Low-power Android TV and older Chromecast-class
  devices also prefer AVC/H.264 for 1080p auto-picks when an AVC source is
  available, while HEVC/AV1 remain available as fallback/manual sources.
- After ExoPlayer reaches READY, normal buffering must not remount or restart
  a movie from the beginning.
- Continue Watching follows `docs-continue-watching.md`: one canonical Home card
  per movie/show, active progress beats next-up, and the saved 4K/1080p source
  class carries into remaining TV episodes.

## Now Watching / Activity

Players send a lightweight `/api/activity` heartbeat while playback is active.
Regular users can only write their own heartbeat; only admins can read the
Settings -> Activity dashboard. The live row is intentionally in-memory and
short TTL so stale sessions disappear if a browser, TV, or network connection
dies. The same endpoint also keeps the previous 10 movie/TV activity rows from
the last three days so the owner can see recent VOD playback without accumulating
a long-term log. Live TV/IPTV is current-activity only and is not retained in
history.

The heartbeat carries both the client path and the stream treatment:

- `player`: `web` or `exo`, showing which player surface owns playback.
- `mode`: the player transport label, such as Direct, Remux, Transcode, or
  ExoPlayer.
- `streamKind` / `streamLabel`: the owner-facing quality status. Movies and
  episodes show `Original`, `Original (remux)`, or `Transcoding`; Live TV shows
  `Live`.
- `clientVersion`: the web or Android app version when the client can report it,
  so the owner can spot TVs/phones that need an update.

This distinction matters because remux is still original-quality playback, while
transcoding means Triboon is actively converting the stream for device support
or a requested quality cap.

## Subtitle Model

Online subtitles are the default production path. The server uses the saved
Wyzie key, or `TRIBOON_WYZIE_KEY` when the dashboard key is empty, to search by
TMDB/IMDb id plus the exact selected release/file hints, downloads WebVTT/SRT,
ranks alternates, caches per mount/language, and serves the result through
signed stream-scope URLs.

Built-in subtitles are an admin-controlled opt-in because embedded text
extraction may require ffmpeg to scan much of the media file. When built-ins
are off, the web and Android players hide embedded/sidecar rows, skip built-in
prewarm/extraction, and go directly to online captions when the catalog id and
Wyzie key are available. When built-ins are on, release sidecars and embedded
text tracks can be tried before online fallback, but bitmap-only subtitle tracks
are not useful as WebVTT captions.

Android native playback displays server-provided VTT through Triboon's native
overlay so subtitle version changes and sync changes do not rebuild ExoPlayer.
The current native path is intentionally online-first for stability; deeper
embedded-track handoff would need a separate Media3 subtitle contract and
device matrix.

## Streaming Performance / Multi-User Capacity

Triboon treats performance as a capacity model, not a single "more connections"
knob. The owner configures provider connection limits, expected simultaneous
users, quality mix, server download/upload speed, and buffer targets in Settings
-> Streaming performance. The server then saves an adaptive profile that the
playback pipeline uses for read-ahead and health probes.

The detailed contract is `docs-streaming-performance.md`. Keep this section as
the architecture summary only; do not duplicate tuning formulas here.

Required behavior:

- Provider connection limits are per account and may be up to 150, because some
  plans advertise 100+ connections. The recommendation flow should still avoid
  using more connections than the server/network can use efficiently.
- Multiple usenet providers combine into one pool, but each provider keeps its
  own cap. Least-loaded healthy providers receive article work first.
- NNTP work is priority-laned: startup/seek work outranks playback, playback
  outranks health checks, and health checks outrank background read-ahead.
- Read-ahead is adaptive. 1080p and 4K targets are saved as seconds for the
  owner, but the engine enforces them as a bounded article window so starts and
  seeks stay fast for other users.
- Health checks keep the 500ms upfront gate. Background triage is lower priority
  and must never starve the segment the player is actively waiting on.
- The historical Easynews benchmark in `bench/RESULTS.md` is evidence for the
  original fast-start assumptions, not a fixed runtime rule. Do not reintroduce
  hardcoded "16 warm connections" or "8-12 read-ahead" behavior without updating
  the capacity reference and tests.

## Live TV / IPTV Source Model

Live TV providers are first-class sources/playlists. There is no longer one
global IPTV cache that every provider shares.

```mermaid
flowchart TD
  SettingsUI["Settings Live TV form\nweb/index.html"] --> Add["POST /api/iptv/sources"]
  SettingsUI --> Delete["DELETE /api/iptv/sources/:id"]
  PrefUI["Preferences Live TV form\nweb/index.html"] --> MyAdd["POST /api/me/iptv/sources"]
  PrefUI --> MyDelete["DELETE /api/me/iptv/sources/:id"]
  Add --> EncSettings["Encrypted settings.iptvSources"]
  MyAdd --> EncSettings
  MyDelete --> EncSettings
  Delete --> EncSettings
  Delete --> Cleanup["clearIptvSourceRuntime\n+ delete source disk caches\n+ remove source favorites/groups"]
  MyDelete --> Cleanup

  EncSettings --> Sources["iptvSourcesFromSettings\nlegacy default source fallback"]
  Sources --> UserSources["iptvSourcesForUser"]
  UserSources --> Channels["loadIptvChannelsForSource"]
  Channels --> DiskCaches["iptvcaches[sourceId]\nepgcaches[sourceId]\nxtreamepgcaches[sourceId]"]
  Channels --> Aggregate["aggregateIptvChannels\nsource-scoped channel ids"]
  Aggregate --> LiveUI["/api/iptv/channels\nLive TV page"]
  Aggregate --> Playback["/api/iptv/native/:idx\n/api/iptv/stream/:idx"]
  DiskCaches --> Guide["/api/iptv/guide\n/api/iptv/epg/:idx"]
  Guide --> PiP["Live TV guide\nplayer PiP guide\nbrowser Multiview"]
  Playback --> Android["Android ExoPlayer\nprovider TS/HLS then server remux"]
  Playback --> Web["Browser MSE\nserver fMP4 remux"]
  AndroidPrefs["Android Preferences\npersonal IPTV on this TV"] --> AndroidStore["Android Keystore-backed\nprivate storage"]
  AndroidStore --> AndroidDirect["Device-side Xtream/M3U load\nno server/VPN hop"]
  AndroidDirect --> LiveUI
  AndroidDirect --> Android
```

Source contract:

- `settings.iptvSources[]` stores source identity, type, display name, M3U URL or
  Xtream host/user/pass, optional XMLTV URL, enabled flag, and user visibility.
- User-owned playlists are also stored in `settings.iptvSources[]`, with
  `ownerUserId` and a one-user visibility list. Browser, Android TV, and other
  signed-in clients use the same account source through `/api/me/iptv/sources`.
- Legacy single-source settings (`iptvMode`, `iptvUrl`, `xtHost`, `xtUser`,
  `xtPass`, `epgUrl`, `iptvUsers`) still migrate through a compatibility
  `default` source only when no new source list exists.
- `iptvcaches`, `epgcaches`, and `xtreamepgcaches` are keyed by source id.
  The old singular `iptvcache`, `epgcache`, and `xtreamepgcache` exist only for
  default-source compatibility.
- Xtream disk channel caches never persist stream URLs with credentials; URLs
  are rebuilt from encrypted settings at read time.
- Aggregated channel ids are source-scoped so duplicate channel names or URLs in
  two playlists do not collide.
- Favorites and hidden groups are user data, but entries belonging to a deleted
  source must be removed during delete cleanup.
- Adding, deleting, and re-adding the same playlist must fetch a fresh source
  cache and must not revive deleted channels.

Playback contract:

- Browser Live TV uses the server fMP4 remux path and must close the previous
  fetch/reader/remux before opening the next channel.
- Browser Live TV owns the live-only player chrome. It hides VOD subtitle,
  audio, surround, and quality controls, shows favorite, and keeps movie/show
  playback controls unchanged.
- Browser Multiview is a separate Live TV surface launched from guide contexts.
  It uses isolated MediaSource state per pane against the same server fMP4
  remux path, supports two, three, or four panes, and routes audio only through
  the highlighted pane. Two panes are side-by-side, three panes use a featured
  primary pane plus two smaller panes, and four panes use a 2x2 grid. Guide
  launchers and close controls stay icon-led so the surface matches the rest of
  the player chrome and remains D-pad scannable. On Android TV, the Live TV
  page entry remains a D-pad-reachable discovery point, but the action
  fail-closes with a native ExoPlayer requirement notice instead of starting
  browser Multiview; unsupported in-player guide launchers stay hidden.
- Pane hover/focus changes the audible pane. OK on a filled pane opens a compact
  pane action row; Live TV panes expose fullscreen/return, swap screen, change
  channel/title, and close screen, while movie/show companion panes also expose
  Back 10s, Play/Pause, and Forward 30s. Empty panes still open the picker
  directly. Browser fullscreen is an internal zoomed-pane state inside
  Multiview so Back/Escape returns to the grid without remounting streams. Swap
  changes visual order only, letting a 3-up secondary pane become the featured
  pane while its MediaSource/video element stays mounted.
- Multiview is capped at four panes because each active pane can consume a
  provider stream and server remux work. Pane failures stay local to that pane
  instead of closing the whole player. Provider `429`/rate-limit responses are
  surfaced as likely IPTV account stream limits so users know why only one
  active channel may work on a single-line provider plan.
- The picker includes Continue Watching as a companion source. Browser
  Multiview can carry an active movie/episode into the first pane or start one
  Continue Watching movie/show through the normal `/api/play` source-selection
  path. VOD companion playback is limited to one pane until explicit capacity
  accounting exists for multiple NZB mounts, health gates, read-ahead windows,
  remuxes, and transcodes. VOD pane seeking follows the main player policy:
  direct playback seeks the element, while remux/transcode panes restart that
  pane at the requested timestamp.
- Account personal IPTV uses the same server playback, guide, source cache, and
  delete cleanup path as shared playlists. Stream URLs bind both the channel
  position and source-scoped channel id so a stale channel cache cannot drift to
  another user's source.
- Android TV/mobile tries native provider-compatible HLS/MPEG-TS URLs first.
  Xtream prefers TS, with HLS as fallback, then the server stereo-AAC fMP4 remux
  path for devices or providers that cannot hold the native stream directly.
- Android TV/mobile must not use browser Multiview over the WebView. Native
  Multiview requires a dedicated Media3/ExoPlayer multi-surface design plus
  memory, decoder, and provider-connection testing. Until then, Android shell
  entries must fail closed before any browser pane is mounted.
- Android TV can also hold personal IPTV sources in the native app. Those
  sources are loaded by `MainActivity.java` from the Android device network,
  merged into `web/index.html` Live TV rows, and played directly by ExoPlayer.
  They are encrypted with Android Keystore-backed app storage, intentionally not
  sent to the Triboon server, not included in server guide caches, and not
  shared with other users or devices.
- Every server IPTV URL open runs through the SSRF guard. Node HTTP fetches use
  a pinned DNS lookup, and the browser fMP4 remux path gives ffmpeg a pinned IP
  URL plus the original `Host` header with upstream redirects disabled.
- Android device-local IPTV validates every resolved address, including
  IPv4-mapped IPv6 and NAT64 forms. ExoPlayer and subtitle/manual HTTP fetches
  connect to the pinned address and send the original `Host` header. Hostname
  HTTPS device-local IPTV is not allowed in this Android shell because it cannot
  be DNS-pinned without replacing the TLS socket stack; add those providers as
  account/server IPTV instead.
- Provider errors are sanitized. Logs may include source id, channel name,
  status, and reason, but never credential-bearing provider URLs.
- A provider 401/403/429 against a cached Xtream stream id must force-refresh
  the source list and retry the same cleaned channel before surfacing failure.
- Background Live TV warmups must not steal responsiveness from active playback;
  visible guide/now-next requests still use bounded source-specific guide paths.

Related verification:

- `test/iptv-cache.test.js` covers source-scoped channels, delete cleanup,
  clean re-add, large M3U stream parsing, XMLTV persistence, retune cleanup, and
  provider failure handling.
- `test/security.test.js` covers route auth and IPTV credential redaction.
- Android stress QA should include 20 Live TV zaps, PiP guide open/back loops,
  and no fatal/provider-protection log markers.

## Data Model

The app state store remains JSON buckets through `server/store.js`. Large
attached local-library scans are the one exception: scanned media items live in
`TRIBOON_DATA/library.sqlite` via `server/library-db.js`, while the library
definitions stay in JSON.

| Store bucket | Owner | Purpose |
| --- | --- | --- |
| `secret` | `server/auth.js` | Generated app secret when `TRIBOON_SECRET` is not supplied. |
| `settings` | `SecureSettings` | Encrypted admin settings: providers, indexers, TMDB, subtitles, Trakt app and linked Trakt OAuth tokens, Live TV sources, streaming performance profile. |
| `users`, `invites` | `server/auth.js`, `server/index.js` | Accounts, roles, profile policy, session epoch, invites, encrypted admin TOTP secret, hashed recovery codes. |
| `watch`, `watchlist` | `server/index.js`, `server/trakt.js` | Per-profile progress, watched state, watchlist, Trakt-imported fallback rows. |
| `activityHistory` | `server/index.js` | Admin-only previous 10 movie/TV playback rows from the last three days; Live TV/IPTV rows are pruned and not retained. |
| `trakt`, `traktOutbox` | `server/trakt.js` | Legacy migration/sync marker bucket and queued scrobble/export operations. OAuth tokens must live encrypted inside `settings.traktTokens`, not plaintext `trakt.json`. |
| `libraries` | `server/index.js` | Attached local folders, owner visibility, kind, path, and display metadata. |
| `library.sqlite` | `server/library-db.js` | Scanned local media catalog: item payloads, TMDB ids, episode keys, genres, sort/page indexes, and local lookup support. |
| `libitems` | `server/index.js` | Legacy scanned-item compatibility bucket. New successful scans delete the JSON copy when SQLite is available. |
| `verdicts`, `ixusage`, `tmdb-cache` | `server/store.js`, `server/index.js`, `server/tmdb.js` | Health verdicts, per-indexer daily usage, metadata cache. |
| `iptvcaches`, `epgcaches`, `xtreamepgcaches` | `server/index.js` | Source-scoped channel, XMLTV, and Xtream guide caches. |
| `iptvfavs`, `iptvgroups` | `server/index.js` | Per-user Live TV favorites and hidden groups. |
| Android `personalIptvSources` | `MainActivity.java` | Device-local IPTV sources saved through Android Keystore-backed private preferences, redacted before the web UI reads them. |

When changing persistence, update:

- the store bucket owner here,
- route auth coverage,
- migration/compatibility behavior for existing data,
- focused tests that prove old data still loads safely.

## Client Responsibilities

### Web UI

- Owns navigation, D-pad focus, browser player chrome, Live TV guide UI, Settings,
  and player overlay behavior.
- Must show a usable shell in under 1 second on Android TV-class devices.
- Must lazy-load large local libraries and catalogs after first focus.
- Uses `/api/libraries/local-lookup` to resolve playable local copies on demand
  instead of loading every attached-library item on startup.
- Sends `/api/activity` heartbeats while a user is watching. Admin Settings
  shows the in-memory "Now Watching" view; this is not persisted and should be
  treated as presence, not history.
- The player stats panel is a basic support/debug view: player path, quality,
  source/file label, size, position, buffer, video/audio format, dropped frames
  where available, and bandwidth estimate where available.
- Must keep Live TV categories in their own lane: Up/Down stays in categories,
  Right enters channels.

### Android TV

- Owns native Media3/ExoPlayer playback for VOD and Live TV. The fullscreen
  path uses a `SurfaceView` player surface, decoder fallback, closest-sync
  seeks, seeded bandwidth, byte-bounded VOD buffers, short back buffers, live
  target-offset tuning, conservative-device HLS caps, and audio offload where
  Android supports it. Sustained post-start VOD stalls trim UI caches and retry
  the same source at the last trustworthy timestamp instead of silently
  switching release or quality.
- Sends native capability claims to the web UI/server before source selection,
  including HDMI/ARC/eARC audio-output passthrough flags for AC3, E-AC3, E-AC3
  JOC, DTS, DTS-HD, and TrueHD. Conservative/budget device detection is allowed
  to suppress HD-audio passthrough even when a codec appears in MediaCodec, and
  low-power devices prefer 1080p AVC/H.264 over HEVC/AV1 for automatic playback
  to keep startup, seeking, and recovery stable on older Chromecast-class boxes.
- Sends native playback stats back to the web UI during ExoPlayer playback and
  exposes the stable GitHub APK aliases through a guarded update-link bridge.
- Shows a native setup/compatibility screen before loading the WebView, refuses
  very old WebView providers, hardware-layers the WebView, defers APK-update
  cache clearing until after first paint, and trims caches on Android low-memory
  callbacks.
- Routes Back through the web `__tvBack()` contract unless native sheets/player
  chrome need to close first.
- Recovers WebView renderer crashes by restoring the last app route or promoting
  native playback out of PiP.

## Security Rules

- Every new endpoint must be added to `ROUTES` with the correct auth level.
- Stream routes require signed stream tokens bound to one mount, file, channel,
  or local item.
- New session/stream tokens use HKDF-separated HMAC keys. Legacy raw-secret
  session tokens are accepted only during normal expiry; stream URLs must use
  the HKDF-scoped key. Password changes bump the user's session epoch so
  already-issued sessions and stream links stop working.
- Admin two-factor sign-in is optional and additive. When enabled, password
  login returns only a short-lived TOTP challenge until a valid authenticator
  code or single-use recovery code is provided. The TOTP secret is encrypted
  with a key derived separately from the server secret, recovery codes are
  stored only as scrypt hashes, and enabling/disabling 2FA bumps the session
  epoch to revoke older sessions.
- Session-token access to mount helpers is limited to the mount owner; scoped
  stream tokens remain valid only for their bound mount/resource.
- Restricted local-library stream, art, thumbnail, and play endpoints must use
  the same library `users[]` ACL as item listing.
- Credentials live in encrypted settings and must not appear in caches, logs,
  UI strings, screenshots, or Git history.
- Trakt OAuth tokens are credentials. Store them only through `SecureSettings`
  and migrate/clear legacy plaintext `data/trakt.json` token fields.
- Server-side IPTV playlist, guide, and native proxy fetches validate every DNS
  result and connect through the already-validated pinned address. Android
  device-local IPTV validates playlist, guide, and playback URLs before network
  open, rejects local/private targets including embedded IPv4-in-IPv6 and
  NAT64/6to4 forms, keeps only a short host-safety cache, and fails closed if
  Keystore encryption is unavailable.
- Remote strings from indexers, providers, metadata, Live TV playlists, and
  subtitles must be escaped before UI insertion.
- Size caps stay on fetched playlists, guides, NZBs, subtitle files, and any
  other untrusted provider response.
- RAR/ZIP/NNTP parser metadata is untrusted: impossible header, central
  directory, name/extra, data, or NNTP BODY sizes must fail before large reads
  or allocations.
- Expensive source/guide/playback routes should keep per-user throttles so one
  client cannot burn shared indexer/provider quota.

## Current Roadmap

Done and verified in the current architecture:

- Phase 1: NZB/RAR/ZIP streaming engine with seeking and multi-provider failover.
- Phase 2: Newznab fan-out, scoring, verdict cache, press-play pipeline.
- Phase 3: auth, invites, Quick Connect, encrypted settings, TMDB proxy, watch state.
- Phase 4: profiles, source caps, remux/transcode ladder, web player, D-pad UI.
- Phase 5 core: Android TV shell, native Media3/ExoPlayer handoff, native Live TV,
  subtitles, Trakt sync, local-library performance work, screensaver, PiP guide,
  source-scoped IPTV playlists, and owner-tunable multi-user streaming capacity.

Still open / future hardening:

- Broader Android hardware matrix automation for Shield, Onn, Fire TV, Chromecast,
  Google TV, and low-memory devices.
- Tauri desktop.
- par2 repair and compressed RAR streaming improvements.
- MDBList and richer catalog rows.
- Intro/credit skip after the playback foundation stays stable.
- Release automation polish: version bump, APK build, GitHub release, stable
  Android TV/mobile APK aliases, and Unraid update confirmation for every
  public release.
- Profile-scoped server sessions for true parental-control enforcement on raw
  `/api/search` and `/api/play`. Current catalog UI filters maturity before a
  title is shown, but arbitrary raw NZB queries do not carry reliable ratings;
  do not claim a hard kids boundary until profile tokens are part of route auth.

## Verification Checklist For Architecture Changes

`VERIFY.md` is the authoritative pre-update gate. Run
`npm.cmd run verify:full` before pushing or calling an architecture-affecting
change done. The list below is only the architecture-specific routing reference
for deciding which area was touched.

Run the narrow test for the area touched, then the full gate before a release:

- Engine or source selection: `npm.cmd test` on Windows, or `npm test` where
  shell policy allows it.
- Streaming capacity/read-ahead/provider changes: `node --test test/e2e.test.js`,
  `node --test test/security.test.js`, `node --test test/phase2.test.js`, then
  `npm.cmd test`.
- IPTV source/cache/playback: `node --test test/iptv-cache.test.js` and
  `node --test test/security.test.js`.
- Web UI behavior: start `node server/index.js`, open `http://localhost:7777`,
  and visually check the route.
- Android TV behavior: build the APK, run the emulator/Shield smoke or
  `bench/android-tv-stress.ps1`, and inspect logs for fatal/provider errors.
- Android release packaging: attach `triboon-tv-vX.Y.Z.apk`,
  `triboon-mobile-vX.Y.Z.apk`, `triboon-tv.apk`, and `triboon-mobile.apk` to
  the GitHub release from the same commit/version as the server and container
  image. Stable Downloader URLs are
  `https://github.com/d1same/triboon/releases/latest/download/triboon-tv.apk`
  and
  `https://github.com/d1same/triboon/releases/latest/download/triboon-mobile.apk`;
  Android update acceptance still depends on package id, matching signing
  certificate, and a higher versionCode. Keep this aligned with
  `docs-app-updates.md`, and do not call a release done until GitHub Actions has
  published the Unraid/container image and both stable APK URLs download the
  newest APKs.
- Documentation: scan for stale phase counts, old stack names, old cache
  ownership statements, and old fixed-connection/read-ahead tuning before
  calling the work done.

## Non-Goals

- No Sonarr/Radarr dependency for normal operation.
- No cloud relay or central service.
- No runtime server npm dependencies without owner approval.
- No credential-bearing provider URLs in public docs, logs, UI, tests, or commits.

For legally obtained content only.
