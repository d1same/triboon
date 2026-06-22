# Triboon Release Audit Checklist

This is the A-to-Z checklist for keeping web and Android TV working as separate player surfaces. Web may use the web player. Android TV must route every movie, episode, local-library item, and live channel to native Media3/ExoPlayer, with no web-player fallback.

## Open Production Issue Tracker

Last audit pass: 2026-06-22. This is the active issue list gathered from the
owner reports, the v1.5.10 production-readiness review, Settings/Preferences
review, graph map, and direct code checks. Treat this section as the release
triage board: every fix should update the status, the connected contract, and
the verification evidence.

Severity key:

- P0: security, release integrity, or device-safety blocker.
- P1: user-visible playback, IPTV, performance, or crash risk.
- P2: correctness/scale issue that can become serious under load or edge data.
- P3: polish, clarity, stale docs, or low-risk cleanup.

| ID | Severity | Status | Finding | Connected surfaces | Required fix / verification |
| --- | --- | --- | --- | --- | --- |
| A1 | P0 | Fixed gate; signed release pending | Public APK is debug-signed. `dist/triboon-tv-v1.5.10.apk` verified with Android debug certificate. | `android/app/build.gradle`, release workflow, GitHub release assets, Android updater. | Gradle release builds now require `TRIBOON_RELEASE_*` signing values outside git and fail without them. Verified `assembleRelease` stops with the signing error; final `apksigner verify --print-certs` still belongs to the first real signed release. |
| A2 | P0 | Fixed | IPTV URL SSRF/private-network risk. Server and Android accepted arbitrary IPTV URLs without blocking loopback, link-local, metadata IPs, or private targets. | `server/index.js` IPTV source creation/fetch/remux, `/api/me/iptv/sources`, Android `openPersonalHttp`, ExoPlayer, native subtitles, server/device-local IPTV. | Server and Android now validate playlist, EPG, redirect, stream, and native subtitle targets before opening them. Node fetches pin DNS through the validated lookup, ffmpeg remux receives a pinned IP URL plus original `Host` header with redirects disabled, Android device-local HTTP connects to the pinned address with Host, and legacy plaintext device IPTV prefs are purged instead of read. |
| A3 | P0 | Fixed with LAN exception | Android WebView bridge was broad, mixed content was always allowed, cleartext is global, and bridge methods did not enforce a verified Triboon origin before sensitive actions. | `MainActivity.java`, `AndroidManifest.xml`, JS bridge, personal IPTV, native playback, guide controls. | Bridge methods and navigation are gated to the exact configured server origin, mixed content is compatibility mode, file/content access is disabled, WebView debugging remains debug-only, and cleartext is explicit through network security config. Cleartext stays enabled for self-hosted/LAN HTTP installs by product design. |
| A4 | P1 | Fixed | YouTube Music could spawn many `yt-dlp` processes through Music Home/search without a global queue. | `server/ytmusic.js`, `server/index.js` Music Home, `web/index.html` cover hydration. | `yt-dlp` work now runs through a global bounded queue with timeout cleanup. `test/security.test.js` asserts active jobs never exceed the queue concurrency. |
| A5 | P1 | Fixed | IPTV guide/provider-protection negative cache was too short and some failed guide fetches deleted cache entries, causing repeated provider calls. | IPTV source caches, Xtream guide cache, Settings guide sync, Live TV/PiP guide. | Provider protection now uses configurable longer dampening, guide failures keep stale data with source-scoped negative cache, and IPTV cache tests cover recovery/backoff behavior. |
| A6 | P1 | Fixed | Browser Live TV remux wrote ffmpeg stdout chunks directly to the HTTP response without respecting backpressure. | `/api/iptv/stream`, ffmpeg remux, browser player, channel changes. | Browser Live TV remux now pauses/resumes ffmpeg stdout on HTTP backpressure; rapid retune coverage confirms old upstream streams close before the next opens. |
| A7 | P1 | Fixed; device smoke still recommended | Android audio/lifecycle handling was incomplete: no audio focus/noisy receiver path found, and `onPause()` closed native playback on every pause. | ExoPlayer, Android home/app switch, HDMI/audio devices, PiP/guide transitions. | ExoPlayer now requests media audio focus, handles noisy-device changes, pauses rather than releases on background, keeps PiP playback alive when Android enters system PiP, and pauses WebView timers while backgrounded. Verified by Android compile and phase4 static regression. |
| A8 | P1 | Fixed | ProviderPool hard-down/auth failure had weak reconnect backoff; a single bad provider could be retried too eagerly in later operations. | `server/nntp.js`, provider health, startup/search/streaming. | Provider pools now honor hard-down backoff and reject queued work while down instead of cycling bad providers. Existing provider health tests plus full suite pass. |
| A9 | P1 | Fixed | `NntpPool.run()` used only the first ordered provider, unlike `stat()`/`body()` failover. | `server/nntp.js`, utility NNTP operations, provider failover. | `run()` now tries ordered providers consistently; `test/e2e.test.js` covers fall-through to the next provider. |
| A10 | P2 | Fixed | IPTV group cleanup had a mojibake separator on one path. | `server/index.js` IPTV group/favorite cleanup. | Group/favorite source prefixes now share the same middle-dot separator constant. Covered by IPTV source cleanup tests. |
| A11 | P2 | Fixed | Live TV guide fallback could still reach legacy/empty IPTV settings after source-scoped fixes, so stale channel paths could query `null`/bad hosts. | `sourceForIptvChannel`, `xtreamEpgList`, `iptvGuide`, legacy settings compatibility. | Guide/playback refresh now requires the channel's own valid source and avoids raw legacy fallback for stale source-scoped channels. IPTV deleted-source/stale-cache tests pass. |
| A12 | P2 | Fixed | Verdict cache expired on read but did not prune stale disk entries on write, so long-lived servers could grow old verdict data. | `server/store.js`, source verdict cache, data folder. | Verdict cache writes now prune expired entries and bound total entries. Store/verdict tests pass in the full suite. |
| A13 | P2 | Fixed | XMLTV programme parser was regex/order fragile and assumed attribute order. | XMLTV ingest, M3U/XMLTV playlists, guide matching. | XMLTV programme attributes are parsed independent of order; security test fixture now covers alternate attribute order. |
| A14 | P2 | Fixed | Newznab dedupe was O(n^2) and recomputed normalized titles inside `find`, which could hurt large result sets. | `server/newznab.js`, search fan-out, source drawer speed. | Newznab dedupe now buckets by normalized title; phase2 scale test dedupes 10k unique rows under the performance guard. |
| A15 | P2 | Fixed | yEnc escape at end-of-buffer could advance past input before CRC caught corruption. | `server/yenc.js`, NZB decode path. | Dangling yEnc escapes are guarded, with a corrupt-input regression in `test/e2e.test.js`. |
| A16 | P2 | Fixed | Stable stream-token lifetime was wider than a strict 6-hour interpretation because old cache-stable URLs used a 6-12 hour quantized expiry. | `server/auth.js`, VLC/native stream URLs, docs. | Stable cache tokens now rotate on a one-hour bucket while staying inside the normal 6-hour stream-token TTL; `test/security.test.js` covers the max validity window. |
| A17 | P3 | Fixed in code; visual smoke recommended | Main Live TV browse empty state may still feel blank compared with admin Settings and Preferences empty states. Code has an empty component, but this needs visual confirmation on the actual landing view. | `web/index.html` Live TV page, Settings Live TV, Preferences Live TV, TV focus. | Main Live TV no-source copy now gives a clear setup path and remains focusable. Needs browser/Android visual smoke during release QA. |
| A18 | P3 | Fixed | Appearance controls for cover size/theme exist in both admin Settings and user Preferences. | Settings -> Display, Preferences -> Display, device-local preferences. | Labels now clarify admin display defaults versus per-device display preferences. |
| A19 | P3 | Fixed | Catalog tab Trakt confirmation printed a partial OAuth client-id prefix while other sensitive settings were fully redacted. Client IDs are not secret, but the display was inconsistent. | `web/index.html` Trakt settings confirmation, Settings -> Catalog. | Trakt confirmation now uses generic saved/missing wording instead of showing an OAuth client-id prefix. |
| A20 | P3 | Fixed | Engine status populated asynchronously on cold Settings open; guide sync showed a next-sync time even with zero sources. Harmless but visually noisy. | Settings engine status, Guide sync panel. | Engine panel starts with `Checking...`; Guide sync reports `disabled` when no source is configured. |
| A21 | P3 | Fixed | Docs/test baseline had stale counts and old APK alias wording; `.gitattributes` did not lock Java LF; local `dist/` contains old duplicate APK names even though they are not tracked/public. | `AGENTS.md`, `CLAUDE.md`, `docs-architecture.md`, `.gitattributes`, local `dist/`. | Docs now show the current test baseline and the TV/mobile stable APK release contract; `.gitattributes` pins Java/Gradle/XML LF and export-ignores internal folders. |
| A22 | P3 | Fixed | Music Home behavior was present in code/tests but not fully reflected in roadmap/release docs. | `web/index.html`, `server/index.js`, `test/security.test.js`, docs. | `docs-architecture.md` now documents Music Home ownership, queueing, tokenized proxy, and web-audio-only scope. |
| A23 | P1 | Fixed | Graph refresh found follow-up issues after the release-hardening pass: embedded IPv4-in-IPv6 IPTV SSRF gaps, tokenized local artwork in saved watch metadata, Music playback priority/cache behavior, stale guide index drift, and low-memory cache pressure. | `server/index.js`, `server/ytmusic.js`, `web/index.html`, `MainActivity.java`, IPTV guide, Continue Watching, YouTube Music. | Server IPTV URL guards now decode IPv4-mapped/compatible, NAT64, and 6to4 literals before private-network checks; watch state strips expiring local artwork tokens and remints local art from canonical keys; active Music playback resolves ahead of background work with bounded cache/autoskip UX; guide requests bind source-scoped channel ids; Android low-memory callbacks clear live/music client caches. Verified by `npm.cmd test` 183/183 plus focused IPTV/security/phase4 tests. |
| A24 | P1 | Fixed; hardware matrix still open | Android punch-list compatibility gaps remained for older WebView providers, weak-box decoder fallback, Live HLS ABR caps, slow native seeks, Live TV target offset/bandwidth seeding, low-memory WebView pressure, loading backdrop decode spikes, device-local IPTV URL validation, native subtitle URL validation, and release shrink hardening. | `MainActivity.java`, `native_player_view.xml`, `AndroidManifest.xml`, `network_security_config.xml`, `android/app/build.gradle`, `proguard-rules.pro`, Android TV/mobile playback. | Android now refuses too-old WebView providers with a native setup message, hardware-layers/pre-rasterizes the WebView, defers APK cache clearing, uses SurfaceView, enables decoder fallback, closest-sync seek, live config, seeded bandwidth, conservative-device Live HLS caps, VOD audio offload, bounded/back buffers, mobile system PiP, stronger trim-memory cleanup, downsampled native backdrops, explicit cleartext config, R8 shrink rules, stricter device-local IPTV validation including embedded private-address forms, ExoPlayer/HTTP Host headers for pinned IPTV, native subtitle URL validation, and legacy plaintext personal-IPTV purge. Verified by Android debug build and release R8 minify task; real Shield/Onn/Fire matrix remains a release smoke requirement. |

Closed, stale, or partly-covered audit items:

- Public GitHub release duplicate APKs: v1.7.0 and later should expose four
  intentional Android assets only: versioned TV/mobile APKs plus stable
  `triboon-tv.apk` and `triboon-mobile.apk` aliases.
- Rapid IPTV retune cleanup: currently covered by focused IPTV tests and prior
  logs showing the previous stream closes before tuning the next one. Keep this
  in the stress pass because it is easy to regress.
- `host=unknown`/invalid guide spam: fixed by clearing aggregate channel state
  when no IPTV source exists and by requiring a valid source for source-scoped
  guide/playback refreshes.
- Music Home process fan-out: fixed by the bounded `yt-dlp` queue and covered by
  a focused queue-concurrency regression test.
- Stable stream-token duration: closed by keeping one-hour cache-stable URLs
  inside the normal 6-hour stream-token lifetime.
- Graph refresh follow-up: closed by adding embedded-IPv4 IPTV URL rejection,
  durable Continue Watching local artwork, Music priority/caching/autoskip
  behavior, guide channel-id binding, and Android low-memory cache trimming.

## Product Surface

- First run: owner setup, encrypted settings, provider/indexer/TMDB setup, and profile creation work from the web UI and Android shell.
- Auth: setup, login, invite, Quick Connect, profile switching, sign out, and expired-session recovery all show understandable next steps.
- Home: Continue Watching, library rows, live rows, calendar/discover/movie/show/music navigation, backdrop focus, watched/remove actions, and cover/backdrop refreshes remain stable.
- Search: exact title and year are used for playback search, including tricky titles and multi-word/spin-off cases.
- Details: Play, Resume, Start over, 1080p/4K preference, Sources, watchlist, watched, trailer, cast, recommendations, seasons, and episode cards all route to the correct target.
- Sources: source rows show clean title, quality, source type, size, score, selected state, and exact release playback. Manual source selection must resume from the latest saved position.
- Local library: local movies and matched TV episodes show playable detail pages, skip online source warmups when owned locally, play the next owned episode without "no sources yet," and open large attached folders without rendering every item at once.
- Music: playback starts in Music and stops when leaving the Music section.
- Music: stays on the web audio path for now; ExoPlayer is reserved for video/live playback unless Android TV later needs native audio-session/background behavior.
- Live TV: source-scoped playlist caches, EPG caches, Xtream guide caches, category scrolling, channel play, guide, PiP guide, back behavior, source add/delete cleanup, and channel retune all stay responsive. Category Up/Down stays in the category lane and Right is the only handoff into channel rows.
- Admin/settings: provider/indexer/library/user/quality-cap edits work in place and invalidate affected caches.

## Web Player

- Web playback uses the web video player only.
- Play opens a loading player immediately instead of freezing on the details page.
- Resume and Start over use the right timestamp behavior.
- 1080p/4K preference is sent to source selection before mounting.
- Manual source change plays the exact selected release and resumes at the latest saved position.
- Failed source advances to the next viable source quickly.
- Audio button is enabled only when alternate audio choices exist.
- CC button is enabled only when subtitle choices or sync controls are meaningful.
- HD button is enabled only when quality choices exist.
- Subtitle selection and subtitle sync update live without restarting the player.
- Player layout: guide left, rewind/play/forward/next centered, CC/audio/HD right, title left above seek, quality right above seek, back button top left, time top right.
- Single click toggles play/pause; double click toggles fullscreen without also pausing.
- Controls use the dark bottom shade and only the focused/hovered button changes visual state.

## Android TV Native Player

- Android TV never reveals or falls back to the web player for movies, episodes, local library, or live TV.
- Details Play/Resume/Start over show native loading immediately, then hand to ExoPlayer.
- Resume works across 1080p/4K and manual source changes for the same title/profile.
- 1080p/4K detail preference chooses the right release class before playback.
- Native source failure advances to the next release instead of closing playback; remux-selected Android sources may first fall through to server transcode when ExoPlayer rejects the remuxed codec.
- Native direct/remux/transcode ladder stays source-fit -> direct -> remux -> transcode.
- Native controls are D-pad reachable and smaller than web controls where needed.
- Native layout: guide left, playback controls centered, CC/audio/HD right, title left above seek, quality right above seek, time and finish time top right.
- Native CC/audio/HD buttons are disabled when no real choices exist.
- Native audio language changes use ExoPlayer track selection live.
- Native CC selection, online subtitle versions, and subtitle sync update the overlay live without rebuilding the player.
- Native guide/PiP keeps ExoPlayer alive over the guide surface and does not black-screen when switching player -> guide -> player -> guide.
- Native live playback recovers inside ExoPlayer from idle, buffering, ended, and not-playing states without falling back to the web player.
- Native movie/episode startup fails over through the existing native ladder if ExoPlayer sits idle or stuck before first frame.
- Live TV retune from guide preserves guide mode and swaps the native player without a web player flash.
- Back from native playback returns to the prior app surface cleanly.

## Security

- API routes remain deny-by-default and every endpoint is represented in the route coverage test.
- Stream URLs use signed stream-scope tokens bound to the mounted resource.
- Native live stream tokens are bound to the selected channel.
- Settings and credentials remain encrypted at rest.
- User roles enforce admin-only provider/indexer/user/settings changes.
- Rate limits protect auth, invite, Quick Connect, and other sensitive endpoints.
- CSP and static serving headers stay in place.
- No credentials or tokens are committed.
- WebView debugging is enabled only for debug APKs.
- Cleartext HTTP is still allowed because Triboon is self-hosted and many local servers are configured by LAN IP; production hardening should offer an HTTPS/local-cert path before narrowing this.

## Performance Targets

- Pressing Play should show loading immediately and reuse warmed search/mount data when available.
- Availability/source prefetch should run for online titles but skip owned local-library titles.
- Bounded health gate stays fast and background triage advances without blocking playback.
- Multi-user VOD capacity follows `docs-streaming-performance.md`: provider
  connection limits round-trip per account, multiple usenet providers combine
  without losing individual caps, startup/seek work outranks read-ahead, and
  active playback bytes outrank health/background work.
- Settings -> Streaming performance should show owner-facing recommendations
  based on provider connections, expected users, remote users, bandwidth, stream
  mix, buffer targets, per-stream connection windows, and startup reserve.
- Keep successful source/mount/watch-state data hot long enough for quick resume and source switches.
- For Android TV, prefer native direct play when the device reports codec support; avoid server remux/transcode unless needed.
- Live TV should serve source-scoped cached playlist/EPG data immediately, refresh server-side on schedule, and never let one playlist's stale channel ids or favorites bleed into another playlist.
- ExoPlayer should keep the SurfaceView-backed fullscreen surface stable during guide/PiP transitions.
- Attached local libraries must not block first menu/home focus or rail rollover; home must not fetch full `/api/libraries/:id/items` payloads, rail previews auto-load only the first bounded local-folder page, and library grids request additional bounded pages through scroll/D-pad.

## Release Packaging

- Android releases publish four APK asset names from the same universal shell
  build: `triboon-tv-vX.Y.Z.apk` and `triboon-mobile-vX.Y.Z.apk` for
  audit/history, plus `triboon-tv.apk` and `triboon-mobile.apk` as stable
  Downloader-style links:
  `https://github.com/d1same/triboon/releases/latest/download/triboon-tv.apk`
  and
  `https://github.com/d1same/triboon/releases/latest/download/triboon-mobile.apk`.
  Avoid any other Android APK aliases; they make the public release look
  duplicated even when all files contain the same APK bytes.
- Android update acceptance depends on the package id, signing key, and higher
  `versionCode`; the APK filename is only for download/link stability.

## Verification Log

- Release v1.7.0 verification: Android native guide/PiP now keeps the
  SurfaceView-backed `PlayerView` fully opaque and animates only a sibling
  reveal scrim, preventing SurfaceView alpha-blend regressions on TV chipsets.
  Native subtitle overlay fetches now validate through
  `validateNativeSubtitleOverlayUrl()` inside the fetch helper while preserving
  pinned personal-IPTV Host headers, so future subtitle callers cannot bypass
  trusted-server/device-local URL checks. Release packaging now carries stable
  TV and mobile aliases from the same universal APK build. Verification passed
  `node --check server/index.js`, `server/transcode.js`, and `server/store.js`;
  `git diff --check`; focused `node --test test/phase4.test.js` 17/17; full
  `npm.cmd test` 186/186; Android `assembleDebug`; Android
  `:app:minifyReleaseWithR8`; tracked-file credential scan for the
  owner-provided API/provider values; `aapt dump badging
  dist/triboon-tv-v1.7.0.apk` reported `versionCode='64'` and
  `versionName='1.7.0'`; and `apksigner verify --print-certs` verified the
  APK. Release assets `triboon-tv-v1.7.0.apk`, `triboon-tv.apk`,
  `triboon-mobile-v1.7.0.apk`, and `triboon-mobile.apk` share SHA-256
  `CEF55F2769A25538560758F01FF6342D809BDDD37B122A0EBDC677FA6DCB22C2`.
- Security closure pass on June 22, 2026: closed the remaining rebind/SSRF
  findings from the Android/server review. Native subtitle URLs now pass through
  the same trusted-server/device-local validation as playback URLs; Android
  device-local HTTP playback and subtitle fetches use pinned addresses plus the
  original Host header; legacy plaintext personal-IPTV prefs are purged; server
  Live TV browser remux gives ffmpeg a pinned IP URL plus Host header and
  disables upstream redirects; and the JSON data directory is chmodded `0700`.
  Verification passed `node --check server/index.js`, `server/transcode.js`,
  and `server/store.js`; `git diff --check`; focused Android native-player,
  IPTV cache/remux, and store-permission tests; full `test/security.test.js`,
  `test/phase4.test.js`, and `test/phase2.test.js`; Android `assembleDebug`;
  Android `:app:minifyReleaseWithR8`; and full `npm.cmd test` 186/186.
- Android compatibility punch-list pass on June 22, 2026: closed the current
  WebView provider floor, SurfaceView/ExoPlayer tuning, device-local IPTV URL
  validation, low-memory lifecycle, mobile PiP, WebView hardening, and Android
  R8/resource-shrink follow-ups in A24. Verification passed `git diff --check`,
  Android `assembleDebug`, Android `:app:minifyReleaseWithR8`, focused
  `node --test --test-name-pattern "Android native player" test/phase4.test.js`,
  and full `npm.cmd test` 185/185.
- Release-audit hardening pass on June 22, 2026: closed the security,
  IPTV/backpressure, Music queue, NNTP failover, XMLTV, Newznab scale, yEnc,
  Settings polish, docs, and Android lifecycle items in the open tracker except
  the first real signed APK certificate verification. Stable stream tokens now
  rotate by one-hour cache buckets while staying inside the 6-hour stream-token
  TTL. Verification passed `node --check` for the
  touched server/test modules, `node --test test/iptv-cache.test.js` 27/27,
  `node --test test/security.test.js` 66/66, `node --test test/phase4.test.js`
  17/17, focused `test/e2e.test.js` NNTP/yEnc regressions, focused
  `test/phase2.test.js` Newznab dedupe regressions, Android
  `:app:compileDebugJavaWithJavac`, expected-failure Android
  `:app:assembleRelease` without signing secrets, and full `npm.cmd test`
  183/183 after the graph refresh follow-up regressions were added. A temporary
  server smoke also confirmed the Live TV shell empty-state copy is present and
  `/api/iptv/channels` + `/api/iptv/status` return clean zero-source states.
- Release v1.5.10 verification: browser/mobile browse surfaces keep the
  backdrop compact or hidden so rows stay visible, Home/Discover vertical D-pad
  moves start at the first thumbnail in the destination row, detail/person
  browser history restores through the visible route instead of jumping back to
  the original page, Live TV empty/error states remain focusable, and Android
  native loading now uses a thin Triboon spinner ring instead of the stock
  chunky ProgressBar. Release packaging now publishes the existing TV stable
  alias plus generic Android TV/mobile stable aliases from the same universal
  shell build. Verification passed inline `web/index.html` script parse,
  `git diff --check`, full `npm.cmd test` 176/176, Android `assembleDebug`,
  and `aapt dump badging dist/triboon-tv-v1.5.10.apk`. Badging reported
  `versionCode='63'` and `versionName='1.5.10'`; post-release public cleanup
  kept `triboon-tv-v1.5.10.apk` and stable `triboon-tv.apk` only. Both share
  SHA-256 `2E324CEF51CDDEBAA203C151EB8DDACC6B54CDB29DD87B1DEDEA9420B77D610C`.
- Release v1.5.9 verification: the Android app shell now treats taps in the
  top-left Android chrome/menu area as the Triboon menu toggle, making the
  stable APK match the latest local web UI after the v1.5.8 IPTV playlist-edit
  release. Verification passed inline `web/index.html` script parse,
  `git diff --check`, full `npm.cmd test` 176/176, and Android
  `assembleDebug`. `aapt dump badging dist/triboon-tv-v1.5.9.apk` reported
  `versionCode='62'` and
  `versionName='1.5.9'`; release APK SHA-256 is
  `818B0C571B8A3E15BF2AB0B97059679F973C88234387DFD2654E0C519A2C5467`.
- Release v1.5.8 verification: IPTV playlists are editable from both admin
  Settings and user Preferences without exposing saved credentials. Edits reuse
  the existing source id, keep saved sensitive fields when edit inputs are
  blank, clear that source's channel/guide cache, and warm the updated playlist
  in the background instead of adding a duplicate. Android device-only IPTV uses
  the same merge-by-id behavior in encrypted local storage. Verification passed
  inline `web/index.html` script parse, `node --test test/iptv-cache.test.js`
  26/26, `node --test test/security.test.js` 63/63, focused
  `node --test --test-name-pattern "Android native player" test/phase4.test.js`,
  full `npm.cmd test` 176/176, `git diff --check`, and Android
  `assembleDebug`. `aapt dump badging dist/triboon-tv-v1.5.8.apk` reported
  `versionCode='61'` and `versionName='1.5.8'`; release APK SHA-256 is
  `A1E09FBECF53F3AC7E5631ABF16DD87EFFEC1AB7E9B46E8A66D16DCB76075C83`.
- Release v1.5.7 verification: profile always-show subtitles now auto-enable
  the preferred online subtitle at startup on web and native playback without
  waiting for web track probing, while manual mode stays quiet and an in-video
  Off choice is not undone by later probes. The player regression map documents
  this subtitle startup contract. Verification passed `node --check
  server/index.js`, inline `web/index.html` script parse, `git diff --check`,
  focused `node --test --test-name-pattern "subtitle startup preference
  contract|Android native player" test/phase4.test.js`, full `npm.cmd test`
  175/175, and Android `assembleDebug`. `aapt dump badging
  dist/triboon-tv-v1.5.7.apk` reported `versionCode='60'` and
  `versionName='1.5.7'`; release APK SHA-256 is
  `C3F928DEA53C78EF2B6FB418D52F59A55F9F6469884CC7501B66140848B78B98`.
- Release v1.5.6 verification: auth gates and the idle screensaver now use the
  updated transparent `web/triboon.png` wordmark with cropped layout sizing,
  and the phase4 regression contract was updated to lock that new logo path in.
  Verification passed `node --check server/index.js`, inline `web/index.html`
  script parse, `git diff --check`, focused `node --test --test-name-pattern
  "Android native player" test/phase4.test.js`, full `npm.cmd test` 174/174,
  and Android `assembleDebug`. `aapt dump badging dist/triboon-tv-v1.5.6.apk`
  reported `versionCode='59'` and `versionName='1.5.6'`; release APK SHA-256
  is `DBB552AD5149E74C81331AA977879DD6CC4FE975A5DCA98B61087E5F13E96FE5`.
- Release v1.5.5 verification: browser/account IPTV sources now save through
  `/api/me/iptv/sources`, are isolated per user, share the server source/cache
  model across browser and Android TV, and keep Android device-only IPTV as a
  separate optional path. Stream URLs now bind both channel position and
  source-scoped channel id, and release docs now require both
  `triboon-tv-vX.Y.Z.apk` and stable `triboon-tv.apk` assets for Downloader
  updates. Verification passed `node --check server/index.js`, inline
  `web/index.html` script parse, `git diff --check`, full `npm.cmd test`
  174/174, and Android `assembleDebug`. `aapt dump badging
  dist/triboon-tv-v1.5.5.apk` reported `versionCode='58'` and
  `versionName='1.5.5'`; release APK SHA-256 is
  `186501FC6938D212E29C0B76D0B6A5252A052E855DE5F0CE0421452D359E0DE3`.
- Release v1.1.21 streaming/IPTV capacity verification: full `npm.cmd test`
  passed 164/164 after the version bump, covering the recent IPTV source/cache,
  Xtream refresh/retry, native proxy redaction, playback, security, subtitle,
  and streaming-performance recommendation paths. Android build passed with the
  repo Gradle wrapper and Android Studio JBR:
  `android/gradlew.bat -p android clean assembleDebug`. `aapt dump badging`
  for `dist/triboon-tv-v1.1.21.apk` reported `versionCode='52'` and
  `versionName='1.1.21'`; release APK SHA-256 is
  `D67A8715CC8C693EDD3C4F2EEE27C372361564DB10F2C1FE1CCA000D42BF1645`.
  This release adds owner-tunable multi-user VOD capacity, higher per-provider
  usenet connection caps, startup/seek NNTP priority over read-ahead, adaptive
  read-ahead under active-user pressure, source-scoped IPTV cleanup/refresh
  hardening, and the documentation contract in `docs-streaming-performance.md`.
- Streaming performance capacity pass: Settings now supports high-connection
  providers up to the current 150 cap, owner-tunable multi-user streaming
  profiles, and an admin-only recommendation endpoint. Runtime playback now
  reserves startup/seek capacity, prioritizes NNTP startup/seek over playback,
  playback over health, and health over read-ahead, and shrinks read-ahead under
  active-stream pressure. Documentation source of truth is
  `docs-streaming-performance.md`; player regression contract is P14.
  Verification passed `node --check server/index.js`,
  `node --check server/pipeline.js`, `node --check server/nntp.js`,
  `node --check server/vfs.js`, focused `node --test test/e2e.test.js`,
  `node --test test/security.test.js`, `node --test test/phase2.test.js`, full
  `npm.cmd test` 164/164, and `git diff --check`.
- `npm.cmd test`: passed 138/138 on June 16, 2026 after the home startup focus/render coalescing fix.
- `node --test test/phase4.test.js`: passed 15/15 on June 16, 2026 after the home startup focus/render coalescing fix.
- Android build: `android/gradlew.bat assembleDebug` passed with Gradle 9.5.1 wrapper fallback on June 16, 2026.
- Android Java compile: `android/gradlew.bat :app:compileDebugJavaWithJavac --rerun-tasks` passed on June 16, 2026, proving the native player edits compile fresh.
- Android Gradle hygiene: `android/gradlew.bat :app:compileDebugJavaWithJavac --warning-mode all` passed without Gradle deprecation warnings after modernizing Groovy DSL assignment syntax; AndroidX annotation metadata warnings were removed with a compile-only annotation dependency.
- Startup smoke: isolated temp server + browser reload reached usable home/menu focus in 174 ms; boot made one `/api/server`, one `/api/me`, one `/api/watch?profile=...`, one `/api/libraries`, and one `/api/watchlist` request.
- IPTV status: the real local server on `localhost:7777` reported TMDB, ffmpeg, Wyzie subtitles, IPTV, and music enabled. The server was restarted with stdout/stderr captured in `triboon-local.out.log` and `triboon-local.err.log`; startup warmed 9875 channels plus XMLTV and 96 Xtream guide channels.
- IPTV native logging: `test/security.test.js` covers upstream native playback failures and proves logs include channel/status while omitting credential-bearing provider URLs.
- IPTV playback probe: Shield WebView session fetched `/api/iptv/channels` with 9875 channels; first native URL returned `video/mp2t` with bytes in about 5.6s, and browser/remux fallback returned `video/mp4` with bytes in about 1.4s.
- IPTV provider rejection audit: `USA: CNN [1080p]` failed on Shield because the upstream provider returned HTTP 403 for both TS and HLS with `[Bot-Protection]: You are banned for repeated abuse`. This is now sanitized as `provider bot-protection`, short-cached by the native proxy to avoid Exo retry storms, and surfaced by Android as an HTTP provider failure instead of a generic Exo source error.
- Android install: debug APK installed on the configured Shield ADB target.
- Android native VOD smoke: started `The Super Mario Galaxy Movie` on Shield; timeline showed `1:38:14`, finish time showed `Ends at`, native rewind moved `0:17 -> 0:00`, native forward jumped to `0:32`, and the web video source stayed empty.
- Android native resume follow-up: a later Shield restore requested resume at 171s but visually restarted near the beginning; native resume now keeps `nativePendingStartMs` and reapplies the seek once ExoPlayer is READY instead of relying only on the immediate post-`prepare()` seek.
- Android native Live TV smoke: started channel 0 through the logged-in app path, caught stale web player state blocking D-pad zapping, fixed `setNativeLivePlaybackState`, reloaded the patched WebView, then confirmed Up moved `liveCur 0 -> 1` and Down moved `liveCur 1 -> 0`.
- Android subtitle smoke: native CC sheet opened with Off, English recommended/versions, and +/-0.5s sync rows; closing the sheet left playback clean.
- Android visual smoke: native video frame rendered; Back returned to the Triboon UI; after Live TV smoke the movie was restored from saved state.
- Android repeatable smoke helper: `bench/android-tv-smoke.ps1` launches/inspects the Shield, writes JSON state, pulls a screenshot to `bench/shots`, and can run the disruptive `-LiveZap` check when a real TV zap proof is needed.
- Android startup D-pad smoke: cold-started the Shield with early D-pad input; web focus was ready at ~198 ms, `/api/watch` returned at ~303 ms, the boot loader was hidden, and focus landed on a card instead of a dead body/WebView focus. This points the old "first 10 seconds frozen" symptom at the frontend first-focus gap, not backend loading.
- Android startup flicker follow-up: after the IPTV native-error changes, cold-started the Shield with early D-pad input again. Web focus was ready at 329 ms, `/api/watch` returned at 372 ms, the boot loader was hidden, early D-pad input landed on a Continue Watching card, and catalog/enrichment rows stayed deferred while the user was already navigating. The fix coalesces unchanged home rows, preserves focus across background row swaps, and waits for the TV focus/D-pad settle window before applying visible background refreshes.
- Continue Watching next-up stability: next-episode suggestions are prepared during the watch-state publish path with a short deadline instead of being added by the generic home enrichment pass several seconds later. Shield cold-start smoke showed the first focused Continue Watching card already carried `NEXT EPISODE` while TV focus stayed under one second.
- Live TV/PiP guide category navigation: category columns now keep their own D-pad lane. Up/Down clamps and applies categories, including at the bottom, and only Right enters the channel rows. `node --test test/phase4.test.js` and `npm.cmd test` passed 138/138 on June 16, 2026 after this fix.
- Android post-install focus follow-up: immediately after `adb install -r`, Android/Play Protect/launcher package-cache work still creates a short OS-level "no focused window" interval before Triboon is displayed. The native shell now reclaims focus on resume, window focus, page finish, and app-ready, then flushes queued D-pad keys. Post-install Shield smoke reached web focus at 111 ms after the app surface was active and early D-pad landed in the home rows.
- Local-library performance pass: attached library item payloads no longer warm from home; home only reuses already-cached explicit library data, rail rollover auto-loads a 15-item page for the highlighted local folder instead of the full scanned list, and library grids request additional 15-item pages with D-pad/scroll-triggered append.
- Local-library Shield probe: cold start reached TV focus at 306 ms. `IR - TV Shows` rail preview originally proved bounded paging by requesting `/api/libraries/dbcd999592/items?offset=0&limit=72&sort=added.desc`, rendering 72 cards from 720 top-level shows, then appending the next bounded page. The UI batch size was later lowered to 15 to make rail previews lighter.
- Browse backdrop sizing pass: Movies, TV Shows, and attached-library pages now toggle `shortBrowseBd`; TV-class 1080p caps the backdrop at 360px high and non-TV 1080p caps it at 420px so poster grids become visually dominant sooner.
- Android repeatable smoke helper now supports `-ColdStart -StartupDpad` for first-open focus readiness and `-VodSmoke` for disruptive native VOD resume/forward/rewind checks, in addition to `-LiveZap`.
- Android native VOD D-pad fix: Shield smoke confirmed subtitles no longer auto-open on playback start, VOD remux D-pad forward remounted from `startOffset 120 -> 173`, rewind remounted back to `171`, and the final screenshot stayed in native playback with no web video source.
- VOD seek loader polish: repeated movie/episode skips are now quiet seeks. Web and Android remux/transcode seek restarts keep the current playback surface instead of flashing the full preparing loader; startup and true failover can still show the branded loader.
- VOD skip flash fix: quiet web remux/transcode seeks now hold the last rendered frame over the source swap, and Android native remux/transcode seeks reuse the active ExoPlayer surface instead of releasing/recreating it, so repeated skip/rewind presses keep the player visually in place.
- ExoPlayer D-pad map fix: visible VOD chrome now gives Left/Right to the button row first, so Play/Pause can move to rewind/forward instead of accidentally skipping. The seek bar can still be selected with Up and scrubbed with Left/Right, hidden VOD surface Left/Right still skips, and Live TV Up/Down remains channel zapping.
- ExoPlayer auto-hide focus fix: when native VOD chrome fades out, logical focus parks on the seek bar; the next hidden Down press reveals the controls with Play/Pause focused instead of opening episode thumbnails or reusing stale button focus.
- ExoPlayer Back behavior fix: with native controls visible, Back hides the controls first. A later Back closes playback through the normal native close callback, which returns movies to movie details and TV episodes to the show detail path.
- Subtitle episode-sync fix: Wyzie/online subtitle ranking now gives exact TV episode matches priority and pushes wrong-episode files below generic fallback rows. Android native subtitles now use the same display timeline as the player after remux/transcode resume or seek, and subtitle-version rows keep their own saved sync offset instead of resetting to zero when selected.
- Subtitle recommended-choice cleanup: CC menus now show one clear Recommended row per language, keep alternate cut/source/group subtitle versions behind More subtitles, avoid provider/generic auto-match wording, and expose +/-5s sync jumps alongside the fine +/-0.5s controls on web and native ExoPlayer.
- Android native Live TV guard: after the VOD D-pad changes, Shield Live TV smoke still moved Up from `liveCur 0 -> 1` and Down back `1 -> 0`, proving VOD seeking did not steal live channel zapping.
- Android smoke helper update: `bench/android-tv-smoke.ps1` now prefers the non-blank WebView DevTools target after APK reinstall, can run `-VodNoSeek` to prove startup overlays stay quiet, and uses exact Android D-pad keycodes for VOD seek checks.
- Fresh APK smoke: after clean rebuild and reinstall, the Shield opened Triboon, exposed the native `TriboonTV` bridge, and kept the web video source empty when playback was requested.
- Episode player follow-up: TV episode playback now shows the show title plus a season/episode subline on web and Android native players. Native ExoPlayer progress now opens the Up Next countdown before the episode ends, and remux/transcode next-episode playback keeps the native seek bar focusable through server-side seeking.
- Up Next countdown check: the next-episode popup now uses one shared 10-second countdown for both the early pre-end popup and the ended fallback path, so users always get the same choice window before autoplay starts.
- Up Next early-skip fix: the pre-end popup now starts only inside that same 10-second choice window. The old 45-second trigger could show a 10-second countdown and auto-play the next episode with roughly 35 seconds still left, effectively skipping the end of the current episode.
- Episode strip follow-up: D-pad episode playback now has a current-season thumbnail row below the controls. Web and native ExoPlayer use the same episode-choice data, default focus lands on the current episode, and selection returns through the regular episode play path instead of a native-only shortcut. The strip now opens with a slide/fade animation and uses larger borderless, rounded 16:9 stills with the episode name below the thumbnail, matching the Continue Watching card language more closely.
- TV detail follow-up: holding OK on a season card now toggles that entire season watched/unwatched through the bulk watch endpoint, then refreshes season badges and the Play/Resume target while restoring focus to the same season.
- TV detail season-year polish: season cards now surface each season's year as a small poster badge and keep the footer focused on the episode count, so show pages are easier to scan from the couch.
- Continue Watching removal polish: removing or marking an item from the home Continue Watching row now captures the action card, preserves the row's horizontal scroll, and restores focus to the same item or the next nearby card instead of jumping back to the row start.
- Continue Watching details fix: the long-press menu now defaults to Details, and the Details action maps episode cards to their parent show detail page before calling `openDetail`, instead of letting episode items fall through to playback.
- Local TV library detail fix: unmatched local shows now open a real local detail page with season cards built from scanned episode metadata, then drill into episode cards inside the selected season. This keeps shows like Bist o Yek from looking like every episode is its own season/grid item.
- Main app clock polish: the top-right web clock is now a slightly larger text-only glass badge with cleaner spacing and pointer-safe chrome, so it feels intentional without crowding browse filters.
- Idle screensaver: after 60 seconds of no app-shell input, Triboon now fades into a fullscreen clock/art screensaver. It uses the full Triboon wordmark logo (`web/triboon.png`, mirrored from `logo/triboon.png`), prewarms a profile-keyed TMDB "Trending Today" artwork cache once a day, falls back to already-visible/cached catalog rows when offline or unconfigured, shows only the active title without year/type metadata, never opens over video playback/login/setup/modals, and the first remote/mouse/touch input only wakes the app instead of also activating a focused card.
- Idle screensaver logo polish: the fullscreen screensaver keeps the Triboon wordmark but scales it down to a compact cropped strip so the clock/art remain dominant.
- Browse Back polish: on Movies, TV Shows, and attached-library grids, Android TV Back first opens the section rail/menu from the current page; a second Back from the rail returns Home.
- Subtitle A-Z follow-up: web and native subtitle choices now use a Recommended-first model, lazy More subtitles expansion, source/cut/group version labels, exact-episode ranking labels, and display-clock subtitle timing so changing subtitles after resume/seek does not restart captions from the beginning.
- June 17, 2026 verification: `node --test test/phase4.test.js`, targeted `node --test --test-name-pattern "subs: pickSub" test/phase2.test.js`, full `npm.cmd test` passed 138/138, `git diff --check` passed, Android `:app:compileDebugJavaWithJavac` passed with Android Studio JBR, `assembleDebug` built the debug APK, and `adb install -r` succeeded on the configured Shield ADB target.
- Public repo cleanup: tracked docs/scripts no longer publish the local Gradle path or Shield ADB address; the Android smoke helper now takes `-Device` or `TRIBOON_ADB_DEVICE`.
- Screensaver transparency follow-up: the idle screensaver now uses a dedicated transparent, tight-cropped `web/triboon-screensaver.png` asset instead of scaling/cropping the large full-logo canvas.
- Subtitle matching follow-up: Wyzie searches now include the exact mounted release/file as `release`, `origin`, `fileName`, and `file` hints, and Triboon's local subtitle ranker gives exact file/release matches priority over generic same-title rows.
- Subtitle sync cleanup: web and native CC menus now expose one Later/Earlier sync pair with the current offset shown in the heading/reset row, instead of separate fine and coarse sync rows.
- Trakt profile sync fix: Trakt-imported watched history and playback progress are account-level fallback rows. Active profiles now merge only `fromTrakt` default rows into `/api/watch?profile=...`, while local default-profile playback remains isolated. Manual Trakt sync/import also invalidates watch caches and repaints Home, Watchlist, Calendar, or Details from the refreshed state so watched marks, Continue Watching, and Calendar watchlist data appear immediately.
- Watchlist/calendar episode metadata fix: A-Z browser smoke caught restricted-filter/calendar paths trying to call invalid `/api/tmdb/episode/:id` routes for episode records. Episode metas now normalize to the parent TV show before certification/upcoming-date checks, matching Continue Watching Details and preventing silent 502s in Watchlist/Calendar.
- A-Z browser release smoke: isolated server on `http://127.0.0.1:7788` with copied app data reached usable Home/menu focus in 101 ms. Smoke visited Home, Movies, TV, Watchlist, Calendar, Search, attached Library, Live TV, Music, Preferences, and Settings; remote Back returned each page to Home; detail Back restored Movies, TV, Library, and Watchlist to the same grid index; browser Back returned `#/tv` to `#/movies`; follow-up HTTP probe for Watchlist/Calendar returned no 4xx/5xx requests after the episode-metadata fix.
- Release v1.1.16 hardening: source selection now carries TMDB original-language and preferred-audio hints into scoring, so English/default titles still demote foreign-only/dubbed releases while non-English originals can prefer original-language or dual/multi-audio sources. Subtitle auto-match now demotes edition-tagged subtitle files for normal theatrical-looking releases while still preferring extended/uncut rows when duration or release text proves that cut. Xtream guide/now-next requests remain available to visible UI during playback, background IPTV warmups pause while playback is active, finite native IPTV proxy responses explicitly end and release their live slot, and Android native playback opens the guide through the native bridge instead of stacking a web guide over ExoPlayer.
- Release v1.1.16 Android stress QA: `bench/android-tv-stress.ps1` on the Android TV emulator passed with 3 page-churn loops, 20 native Live TV zaps, 5 PiP guide open/back cycles, 20 VOD forward/rewind seeks, source-quality checks for 1080p vs 4K, subtitle lookup returning HTTP 200 with variants and no 401, and no fatal/provider-protection markers in the log scan. The emulator still logged an expected HEVC decoder capability failure for one VOD source, and the app fell through without a stuck loader.
- Release v1.1.20 Shield IPTV stale-cache audit: ADB/CDP against the NVIDIA Shield showed the APK still installed at v1.1.18, but the production server was already v1.1.19, proving the remaining failure was server-side. The Shield WebView reported 11,462 Xtream channels and sampled dead stream IDs such as CNN `290812`, ESPN `829512`, NESN `829489`, and BBC `714835`; direct provider API from the same account returned 9,876 current streams with working CNN/NESN/TNT IDs such as `13442`, `13583`, and `37655`. The server returned sanitized backend HTTP 403 in under 1 second for native TS, HLS fallback, and browser remux, so ExoPlayer never received playable media bytes. Fix: Xtream channel refreshes now cache-bust provider panel calls with no-cache headers and the smart-TV UA, and cached native/remux 401/403/429 failures must trigger the same forced stale-ID refresh instead of short-circuiting playback. Verification passed `node --check server/index.js`, `node --test test/iptv-cache.test.js` 13/13, `node --test test/security.test.js` 61/61, full `npm.cmd test` 158/158, `git diff --check`, and `android/gradlew.bat assembleDebug`. `aapt dump badging dist/triboon-tv-v1.1.20.apk` reported `versionCode='51'` and `versionName='1.1.20'`; release APK SHA-256 is `53A619F540FCE0BFB1D5A27F1DC34CDC212A0C9F5A05ABFE34323C2D51975043`.
- Release v1.5.0 verification: Continue Watching now dedupes by canonical movie/show identity, preserves the selected 4K/1080p source class into remaining TV episodes, and keeps D-pad focus in the row after remove/mark actions. Live TV source diagnostics and Settings -> Live TV guide sync status now show partial-source failures without hiding healthy playlists, expose a 12-hour guide refresh view, and keep non-live/VOD playlists from hard-failing the screen. Settings/Preferences were checked in the browser at 1280x720 with no horizontal overflow; Settings -> Live TV showed 2 mock channels, 1/1 guide-covered source, and a redacted playlist row; Live TV guide D-pad smoke kept Down inside categories at the bottom and moved into guide rows only on Right. Verification passed `node --check server/index.js`, inline `web/index.html` script parse, `NODE_OPTIONS=--trace-warnings node --test test/iptv-cache.test.js` 20/20, `node --test test/security.test.js` 62/62, full `npm.cmd test` 168/168, `git diff --check`, and `android/gradlew.bat -p android assembleDebug`. `aapt dump badging dist/triboon-tv-v1.5.0.apk` reported `versionCode='53'` and `versionName='1.5.0'`; release APK SHA-256 is `C77E95263B2A78555F8A70ECB8F3E64CA92FE0D86A2F85A36090135F737D8E0D`.
- IPTV source-scoping pass: Live TV playlists now behave like first-class sources. New `/api/iptv/sources` add/list/delete routes store M3U/Xtream sources in encrypted settings, legacy single-playlist settings migrate through the compatibility `default` source, and each source owns its channel cache, XMLTV cache, Xtream guide cache, scoped channel ids, and delete cleanup. Multiple playlists can coexist without channel-id/favorite/group collisions; deleting one source removes its cache and source-prefixed favorites, then re-adding the same URL fetches a fresh playlist instead of reviving deleted state. Verification passed `node --check server/index.js`, `node --test test/iptv-cache.test.js` 16/16, `node --test test/security.test.js` 61/61, full `npm.cmd test` 161/161, browser Settings source add/delete smoke, `git diff --check`, and a targeted secret scan with no real credentials found.
- Node listener warning fix: repeated isolated test boots no longer stack process `exit` listeners from the YouTube Music temporary-cookie cleanup path. `server/index.js` now registers one process-level cleanup registry through `Symbol.for('triboon.ytCookieCleanup')`, tracks per-server cookie maps, unregisters a map during `shutdown()`, and still removes temp cookie files on process exit. Regression coverage in `test/iptv-cache.test.js` boots/shuts down the server 12 times and asserts listener count stays bounded. Verification passed `node --check server/index.js`, `NODE_OPTIONS=--trace-warnings node --test test/iptv-cache.test.js` 17/17 with no `MaxListenersExceededWarning`, `node --test test/security.test.js` 62/62, `npm.cmd test` 164/164, and `git diff --check`.
- Live TV source diagnostics follow-up: `/api/iptv/channels` now returns healthy channels plus `sourceErrors` for failed or non-live M3U/Xtream sources instead of turning the whole Live TV screen into a 502. A TV-show/VOD playlist added under Live TV now produces an empty-state diagnostic (`no live channels found in this source`), while other working Live TV playlists keep rendering with a compact warning. Regression coverage proves one bad playlist cannot hide a healthy source and that all-non-live playlists return a 200 empty state. Verification passed `node --check server/index.js`, `NODE_OPTIONS=--trace-warnings node --test test/iptv-cache.test.js` 19/19, `node --test test/security.test.js` 62/62, full `npm.cmd test` 166/166, and `git diff --check`.
- Settings/Preferences Live TV sync review: Preferences remains the per-user surface for display, playback, sidebar, profile, Trakt, and personal Live TV category visibility; Settings remains the admin-only surface for providers, catalog keys, libraries, users, and Live TV playlist/source ownership. Settings -> Live TV now has a compact Guide sync health panel backed by admin-only `/api/iptv/status` and `/api/iptv/refresh`, showing total cached channels, loaded sources, guide coverage, next 12-hour sync, source-level failures, and a force-refresh action. Server warmups record started/finished status, isolate source failures, serve stale guide data while refreshing, cancel a pending source-change warmup when a manual refresh replaces it, and reset scheduled state cleanly on shutdown. Verification passed `node --check server/index.js`, inline `web/index.html` script parse, `NODE_OPTIONS=--trace-warnings node --test test/iptv-cache.test.js` 20/20, `node --test test/security.test.js` 62/62, Settings -> Live TV Chrome render smoke at 1280x720 with no horizontal overflow, and full `npm.cmd test` 168/168.
- Shield Live TV and rail D-pad follow-up: ADB/CDP on the NVIDIA Shield showed Triboon TV v1.5.0 pointed at the production server and logged in as a regular `user`, so Server Settings is correctly hidden there while Preferences remains visible. The Live TV page was configured but `/api/iptv/channels` returned zero channels because the Xtream provider rejected the optional `get_live_categories` panel call with HTTP 403. Xtream category loading is now best-effort: category failures log a sanitized warning and streams still load from `get_live_streams` under the generic `Other` group. Rail D-pad movement now uses actual rendered visibility via `visibleRailButtons()` for focus, enter, and activation, so bottom rail entries like Preferences/Settings are not miscounted when CSS or preferences hide items. Verification passed `node --check server/index.js`, inline `web/index.html` script parse, `NODE_OPTIONS=--trace-warnings node --test test/iptv-cache.test.js` 21/21, and `node --test test/phase4.test.js` 16/16.
- Live TV sync-status stale-error fix: Settings -> Live TV can display older `/api/iptv/status` source errors from the persisted sync record, while `/api/iptv/channels` may already have recovered a healthy source. The status snapshot now separates channel-list health from guide health: if a source has current channels, stale channel-load failures such as optional Xtream `get_live_categories` 403s are suppressed, but real XMLTV/Xtream guide failures still remain visible. Regression coverage seeds the exact stale category error shape, reloads streams successfully, and proves the Guide sync panel reports one loaded source with no red source issue.
- Real Xtream playlist QA follow-up: a temporary local admin source using the owner-provided real Xtream line added through `/api/iptv/sources` without exposing username/password in the source response, loaded 11,458 channels in ~1.4-1.6s with no source errors, and started native TS playback on three channels in ~0.5-0.8s plus the web remux endpoint in ~1.2s. The first scheduled guide warm completed in ~38s with XMLTV and Xtream guide cache coverage; because pressing Refresh during that warm returns `skipped: running`, Settings now toasts "Live TV refresh already running" instead of falsely saying the refresh completed.
- Release v1.5.1 verification: local admin real-source QA added the new Xtream playlist to the real local app, loaded 11,458 channels, confirmed 1/1 loaded source with 996 cached guide channels and no source errors, validated a CNN guide row with 9 programmes, and started three native TS streams plus the web remux stream. Release checks passed `node --check server/index.js`, inline `web/index.html` script parse, full `npm.cmd test` 170/170, `android/gradlew.bat -p android assembleDebug`, `git diff --check`, and a targeted credential scan for the owner-provided provider/TMDB/indexer/subtitle values. `aapt dump badging dist/triboon-tv-v1.5.1.apk` reported `versionCode='54'` and `versionName='1.5.1'`; release APK SHA-256 is `DEAF75C4FCA21B87A0950408E9E29003AEC69C0B5200085A2865B86405A9DE8B`.
- IPTV/Android TV v1.5.2 follow-up: Xtream source URLs are normalized with `http://` when the admin enters a bare host, and the main channel-list load now falls back to the provider's Xtream M3U playlist when `player_api.php?action=get_live_streams` is rejected. This keeps a provider that blocks panel stream-list calls from showing `0 channels` as long as its M3U playlist is valid, while still persisting only credential-redacted channel metadata. Android TV D-pad arrows now stay inside Triboon's form navigator even when a Settings/Preferences input or dropdown has focus; OK/Enter remains native so select pickers can still open. Profile switching/sign-out are explicit buttons in Preferences -> Profiles & PINs, and login/profile gates plus boot-ready views signal the native shell that D-pad dispatch can start. Verification passed `node --check server/index.js`, inline `web/index.html` script parse, `node --test test/iptv-cache.test.js` 23/23, `node --test test/phase4.test.js` 16/16, full `npm.cmd test` 171/171, `git diff --check`, Android `assembleDebug`, a TV-mode Chrome DevTools smoke for profile buttons/profile picker/settings-input D-pad, a local IPTV status probe showing 11,458 channels, 1/1 loaded source, and 0 source errors, plus a targeted tracked-file credential scan. `aapt dump badging dist/triboon-tv-v1.5.2.apk` reported `versionCode='55'` and `versionName='1.5.2'`; release APK SHA-256 is `9125C2C4B99B18E57B7BCEE1E6727D60FABACC9EF3736AB6B995B42E0EADEE07`. The Android TV emulator launched and installed the patched APK but the emulator process exited during visual screenshot capture, so visual emulator QA remains a host-emulator stability retry instead of a claimed pass.
- Release v1.5.3 verification: Preferences and Server Settings now share a section-aware D-pad form navigator: Up/Down stays in the left tab list, Right enters the active panel, Left returns from a panel to its tab, and Left from the tab exits to the main rail. ADB/CDP on the NVIDIA Shield reproduced the old Preferences failure where Right could not enter the actual controls, then verified the fixed path by selecting Cover size -> Medium with real Shield D-pad/OK and confirming `triboon.cover = M`. Local Chrome smoke checked Preferences and Server Settings tab/panel traversal, including dropdown/input rows. Trailer playback chrome is simplified into a backdrop-driven modal with Back/Close/Watchlist controls so the global hollow focus ring no longer fights the trailer controls. Verification passed `node --check server/index.js`, inline `web/index.html` script parse, full `npm.cmd test` 171/171, `git diff --check`, Android `assembleDebug`, and a targeted tracked-file credential scan. `aapt dump badging dist/triboon-tv-v1.5.3.apk` reported `versionCode='56'` and `versionName='1.5.3'`; release APK SHA-256 is `888ABFAEE1A2A5B53F8606294A0ABB8A8D7BDE30981632DF81D37DEB683AD6E6`.
- Release v1.5.4 verification: Login/profile gates now use a real artwork backdrop fed by a public `/api/auth-art` endpoint that only returns safe TMDB title/kind/backdrop/poster metadata, never the TMDB key or upstream request path. The shared action-menu icon polish now also covers Continue Watching hover buttons and episode menus, and menu click handling reads the nearest action button so pressing an icon/label inside the button still runs the intended action. The long-press title menu contract remains Details first and Resume second; `test/phase4.test.js` asserts that contract against the shared `actionMenuButton()` helper. Verification passed `node --check server/index.js`, inline `web/index.html` script parse, `node --test test/phase4.test.js` 16/16, full `npm.cmd test` 172/172, `git diff --check`, Android `assembleDebug`, and a targeted tracked-file credential scan. `aapt dump badging dist/triboon-tv-v1.5.4.apk` reported `versionCode='57'` and `versionName='1.5.4'`; release APK SHA-256 is `E0F457031D3485993E284ABB4FA6FD44F293043B5905CF3E2B74E0D88B1EEB40`.
- Continue Watching contract follow-up: Home now canonicalizes Continue Watching by movie/show identity before rendering, so 4K/1080p versions or duplicate TV episode records collapse to one card while active in-progress beats next-up. The saved source class (`qualityRank`) carries from watch state into `/api/watch/next`, regular episode targets, Up Next, and the player episode strip so a 4K show continues remaining episodes in 4K. Remove/mark actions update the local watch cache and repaint with `watchReady: true`, preventing the old empty-row flicker that could move D-pad focus into Live TV. The long-term reference is `docs-continue-watching.md`.
- Release v1.1.19 Shield IPTV stale-ID fix: ADB/CDP on the NVIDIA Shield confirmed Triboon TV v1.1.18 was trying native Live TV TS/HLS/remux fallbacks but every path received sanitized backend HTTP 403 before media bytes. The provider API and direct provider media probes succeeded from the same Xtream account, while the production app served 11,462 cached channels against a current provider list of 9,876 channels, proving stale persisted Xtream stream IDs rather than an Android decoder failure. Native proxy and server remux now force-refresh the Xtream channel list on 401/403, match the same cleaned channel name/group, retry the refreshed stream ID once, and expose `/api/server.version` so Unraid/update status can be verified from the running server. Verification passed `node --test test/iptv-cache.test.js` 12/12, `node --test test/security.test.js` 61/61, the focused Android native player regression, full `npm.cmd test` 157/157, `git diff --check`, and `android/gradlew.bat assembleDebug`. `aapt dump badging dist/triboon-tv-v1.1.19.apk` reported `versionCode='50'` and `versionName='1.1.19'`; release APK SHA-256 is `3E02F3520AD4470406638AF09DDD77DFDB93F60E00249166F74C3FC949D029A8`.
- Release v1.1.18 IPTV fallback fix: Android/native Live TV still tries provider TS/HLS first, but the server fMP4 remux fallback now also ingests Xtream TS before HLS so Onn/Chromecast-class fallback follows the same provider-compatible path that works on Shield instead of tripping HLS-only 403s. Verification passed `node --test test/iptv-cache.test.js` 11/11, `node --test test/security.test.js` 61/61, the focused Android native player regression, full `npm.cmd test` 156/156, `git diff --check`, and `android/gradlew.bat assembleDebug`. `aapt dump badging dist/triboon-tv-v1.1.18.apk` reported `versionCode='49'` and `versionName='1.1.18'`; release APK SHA-256 is `554056CA9B6D8E9BEB4EAA13FC3898486494E49A533D81C016FA034D8B0ED13F`.
- Release v1.1.16 verification: full `npm.cmd test` passed 154/154; standalone `node --test test/security.test.js` passed 61/61 after fixing the subtitle-test cleanup hang; `git diff --check` passed; `android/gradlew.bat -p android assembleDebug` passed; `aapt dump badging dist/triboon-tv-v1.1.16.apk` reported `versionCode='47'` and `versionName='1.1.16'`; release APK SHA-256 is `DD61BA9F901EA3BC0F56691DEEB3C6A3DBCEEA289D3ADF49A7E7B5F1CA9DDF0A`.
- Release v1.1.15 emulator QA: Android TV emulator safe-render pass verified native Live TV playback, fast channel Up/Down retune without provider 403/404/fatal logs, PiP guide open/back/fullscreen recovery, category-rail Down clamping with Right-only channel handoff, VOD subtitle lookup returning authenticated WebVTT without HTTP 401, and VOD fallback from rejected HEVC remux to server transcode without leaving the branded loader onscreen.
- Release v1.1.15 source QA: live app-side search for `The Lord of the Rings The Fellowship of the Ring 2001` returned 61/61 1080p candidates for rank 3 and 61/61 2160p candidates for rank 4, matching the automated source-quality tests.
- Release v1.1.15 verification: `node --test test/e2e.test.js test/archive.test.js test/phase2.test.js test/phase4.test.js test/iptv-cache.test.js` passed 93/93; focused security slices passed route coverage, source/title quality policy, IPTV native proxy credential redaction, stream-token binding, and security headers; `git diff --check` passed; `android/gradlew.bat -p android clean assembleDebug` passed; `aapt dump badging dist/triboon-tv-v1.1.15.apk` reported `versionCode='46'` and `versionName='1.1.15'`; `adb install -r dist/triboon-tv-v1.1.15.apk` succeeded on the Android TV emulator, and launch smoke reached `#/home` with boot complete, visible rows, and D-pad focus on the rail. Release APK SHA-256 is `B3F009A080B8A94706B15FD268E2DEF58E257CC4114406C8793F65E510DD9FBE`. Full `npm.cmd test`, standalone `test/security.test.js`, and old isolated Xtream/subtitle security patterns were attempted but hit local timeouts, so this release is gated by the same Docker-publish suite pattern as v1.1.14 plus focused security slices.
- Release v1.1.14 verification: `node --test test/e2e.test.js test/archive.test.js test/phase2.test.js test/phase4.test.js test/iptv-cache.test.js` passed 93/93 after the IPTV retune/provider-protection and native PiP/fullscreen fixes; `git diff --check` passed; `gradle -p android clean assembleDebug` passed; `aapt dump badging dist/triboon-tv-v1.1.14.apk` reported `versionCode='45'` and `versionName='1.1.14'`; release APK SHA-256 is `3221DC5558301154741913074630E0BC4976FA91C42F28328C78B872922D27E8`. Full `npm.cmd test` was attempted and hit the 15-minute local timeout in the security-inclusive suite, so this release is gated by the Docker publish suite instead.
- Release v1.1.7 verification: full `npm.cmd test` passed 142/142 after the native VOD rebuffer/resume fix, `gradle -p android clean assembleDebug` passed with Android Studio JBR, and `git diff --check` passed. `aapt dump badging dist/triboon-tv-v1.1.7.apk` reported `versionCode='38'` and `versionName='1.1.7'`; release APK SHA-256 is `B66CB387D0664F03DAE20DAEEF177DC1C85290B3DD7DBC8D7A04A0312B35CFEF`. This release makes the Android native VOD watchdog startup-only after ExoPlayer reaches `STATE_READY`, preserves the last trustworthy movie position when Exo reports a bogus zero during error/reset, and keeps web/native fallback from restarting movies or episodes at the beginning after a mid-play buffer.
- Release v1.1.6 verification: `node --test test/iptv-cache.test.js` passed 8/8, focused `node --test --test-name-pattern "boot|iptv: native proxy|iptv: Xtream API|teardown" test/security.test.js` passed 4/4, `node --test test/phase2.test.js` passed 28/28, `node --test test/phase4.test.js` passed 15/15, `node --test test/e2e.test.js test/archive.test.js` passed 31/31, `node --test test/security.test.js` passed 60/60 after updating the M3U native-user-agent assertion, full `npm.cmd test` passed 142/142, and `git diff --check` passed. `android/gradlew.bat -p android clean assembleDebug` passed with Android Studio JBR; `aapt dump badging dist/triboon-tv-v1.1.6.apk` reported `versionCode='37'` and `versionName='1.1.6'`; release APK SHA-256 is `F6C9F772DDD46B07041D16ED752CBC11C5C5629C92905B1BF2F71D1D2C8F8A82`. This release covers native Live TV chrome de-duplication and faster zap buffering, PiP/guide screensaver wakeup, Continue Watching recency ordering for next-up cards, native episode subline placement, Xtream channel cache survival, and crash-safe credential-redacted IPTV/Xtream logging for provider timeouts/403s.
- Release v1.1.5 verification: `node --test test/e2e.test.js test/archive.test.js test/phase2.test.js test/phase4.test.js test/iptv-cache.test.js` passed 80/80; focused `test/phase4.test.js` passed 15/15 and `test/iptv-cache.test.js` passed 6/6 after the Live TV connection-cleanup fix; `npm.cmd test` and a targeted `test/security.test.js` run timed out, so the full security suite is not claimed for this release. `android/gradlew.bat -p android clean assembleDebug` passed with Android Studio JBR; `aapt dump badging dist/triboon-tv-v1.1.5.apk` reported `versionCode='36'` and `versionName='1.1.5'`; `adb install -r dist/triboon-tv-v1.1.5.apk` succeeded on the configured Shield ADB target; release APK SHA-256 is `559A8992BC2F1DDD0A11F860EA6580AA9C88A31A4DF24B18F5E57F43D1E6DB76`. Browser Live TV retune cleanup was checked against the real provider path: CNN/FOX returned sanitized provider 403s, and the live-remux ffmpeg worker count remained 0 after both attempts.
- Release v1.1.4 verification: `npm.cmd test` passed 139/139; `android/gradlew.bat clean assembleDebug` passed with Android Studio JBR; `aapt dump badging dist/triboon-tv-v1.1.4.apk` reported `versionCode='35'` and `versionName='1.1.4'`; `adb install -r dist/triboon-tv-v1.1.4.apk` succeeded on the configured Shield ADB target; release APK SHA-256 is `4E41300FA63FE268F6623BC47A3FA1D49D311D582577C2341028D4209D6B7F10`.
- IPTV Xtream/XMLTV follow-up: local browser playback of `USA: CNN [1080p]` opened the Live TV player, decoded a 1920x1080 frame, cleared the startup loader, and produced no fresh server-side 403 or browser console errors during that run. Earlier 403s were reproduced on native/provider paths when TS-first playback and player-shaped user agents double-hit upstream channels, so Xtream native playback now requests HLS first with the Triboon smart-TV user agent and keeps TS as fallback. A mock-provider check verified Xtream HLS-first/fallback behavior, credential redaction, EPG now/next caching, M3U XMLTV exact `tvg-id` matching, normalized channel-name guide matching, and native proxy smart-TV headers.
- Real IPTV provider smoke (June 17, 2026): isolated temp servers were configured from encrypted local settings. Xtream mode loaded 9,876 channels, selected `USA: CNN [1080p]`, returned EPG now/next and 4 guide programmes, served native HLS with bytes, and served browser fMP4 remux with bytes in 8.2s. Real M3U/XMLTV mode exposed the provider issue: the supplied M3U is about 521MB, so the old full-buffer parser failed at the 50MB/128MB cap. The M3U path now stream-parses to the 20,000-channel cap without waiting for provider EOF; real M3U/XMLTV then selected `USA: CNN [1080p]`, returned EPG now/next and 6 guide programmes, served native TS bytes, and served browser fMP4 remux bytes in 14.1s. Captured logs did not include the provider account or credential-bearing `/live/.../.../` paths.
- Browser IPTV provider-error smoke (June 17, 2026): after repeated real-provider probes, the provider temporarily returned HTTP 403 for CNN/ABC/BBC on both native proxy and browser remux. The server returned sanitized `provider bot-protection` / `provider rejected this channel` headers, and the browser UI now shows `Live stream unavailable` with a retry/try-another-channel message while hiding the VLC URL/copy controls. This avoids implying VLC will fix a provider-side rejection.
- Release v1.1.3 verification: `npm.cmd test` passed 138/138; `android/gradlew.bat clean assembleDebug` passed with Android Studio JBR; `aapt dump badging dist/triboon-tv-v1.1.3.apk` reported `versionCode='34'` and `versionName='1.1.3'`; `adb install -r dist/triboon-tv-v1.1.3.apk` succeeded on the configured Shield ADB target; release APK SHA-256 is `E167163EBCA7C7F918AD29F7C08E50B68F3E875A966F611C9A88916EE90EEA18`.
- Release v1.1.2 verification: `git diff --check` passed; `npm.cmd test` passed 138/138; `android/gradlew.bat clean assembleDebug` passed; `aapt dump badging dist/triboon-tv-v1.1.2.apk` reported `versionCode='33'` and `versionName='1.1.2'`; release APK SHA-256 is `282D22B689DA0718500835AFE843136077E11582CC0A28C5B108CA6B4477F9C3`.
- Web smoke: opened `http://localhost:7777/#/home`, verified home/navigation/cards/live rows, opened a movie detail, and started web playback through `/api/remux/...` with title and 1080p label visible.
- Security quick scan: no tracked-source secret hits found; `npm audit --omit=dev` is not applicable because this stdlib server has no lockfile/runtime npm dependency tree.
- Security sweep follow-up: fixed the confirmed high-risk audit items. Trakt OAuth tokens now live in encrypted `settings.traktTokens` with legacy plaintext `data/trakt.json` migration/clear; local-library stream/art/thumb/play paths enforce the same `lib.users` ACL as item listing; server IPTV playlist/XMLTV/native proxy requests validate all DNS answers and connect to the pinned address; Android personal IPTV storage fails closed on Keystore encryption failure, disables app backup, validates native playback URLs before ExoPlayer, and no longer allows cross-protocol redirects; JSON store writes are chmodded `0600` on supported filesystems. Additional hardening added per-user throttles for search/play/advance/IPTV guide endpoints, per-user mount trimming, session epochs that revoke old sessions/stream links after password changes, HKDF-separated HMAC/settings keys with legacy verification/decrypt fallback, mount-owner checks for session-token helper access, bounded RAR/ZIP metadata parsing, an NNTP BODY size cap, and an ffmpeg live-remux protocol whitelist. Focused verification passed `node --test test/security.test.js` 67/67, `node --test test/archive.test.js` 21/21, `node --test test/phase4.test.js` 17/17, `node --test test/iptv-cache.test.js` 27/27, and `node --test test/e2e.test.js` 14/14. Remaining design note: true hard parental-control enforcement for arbitrary raw `/api/search` and `/api/play` needs profile-scoped server sessions because raw NZB queries do not carry trustworthy ratings.

## Remaining Improvements

- Keep expanding the Android automation coverage around audio-language switching, quality sheet D-pad sorting, and real-device first-frame timing. Startup D-pad, native VOD resume/seek, Live TV zap, PiP guide, source quality, and subtitle lookup now have repeatable ADB/CDP stress modes.
- Add an HTTPS/local-cert setup path so production APKs can eventually narrow cleartext traffic without breaking LAN installs.
- Replace deprecated Android platform calls reported by Java lint when we next touch display/WebView setup; Gradle 10 configuration deprecations are already cleaned.
- Add timing telemetry around detail click -> loading, loading -> first frame, source failure -> next source, and live retune -> first frame, especially on Shield.
- Investigate titles that still sit on "preparing stream" before Android receives a native URL; once ExoPlayer starts, the native startup watchdog now fails over instead of waiting forever.
- Consider a native-side warm ExoPlayer/surface strategy if measured first-frame time remains slow after source/mount caching.
- Investigate repeated Shield WebView `tile_manager.cc` tile-memory warnings seen around detail/player transitions; no crash or ExoPlayer fatal error was observed, but it may still contribute to perceived UI jank.
