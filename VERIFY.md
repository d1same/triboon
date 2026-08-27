# Verify Before Any Update

This is the single verification gate for Triboon. Use it before pushing,
publishing, tagging, or telling the owner a fix is done.

If this file disagrees with another `.md`, this file wins. Update this file
first, then update the supporting doc.

Dated evidence below preserves what was true when a run happened. Historical
provider terms, local-only report paths, and old asset names are not current
setup instructions; use `README.md`, `docs-setup.md`, and
`docs-app-updates.md` for today's public contract.

## Hard Stop Rules

- Do not push or say "fixed" while a required gate is failing.
- Do not weaken or delete a failing test. Fix the product or call out the
  blocker.
- Do not claim Web Player or Android ExoPlayer coverage from code inspection
  alone.
- Do not claim Windows GPU playback from a successful compile or requested mpv
  option. A real Windows playback smoke must show advancing frames and a
  hardware value from `hwdec-current`; otherwise report software fallback or
  unverified.
- Do not claim IPTV coverage without source/cache checks and at least one real
  channel start path.
- Do not claim subtitles/CC coverage unless captions are selectable, visible,
  synced, and bounded in the player.
- If provider credentials, a configured server, or an Android device are
  unavailable, report the exact gap as unverified. Do not call the update done.

## One Command

Run the full automated gate from Windows PowerShell:

```powershell
npm.cmd run verify:full
```

That command runs:

- whitespace diff check;
- JavaScript syntax checks for tracked `.js` files;
- inline `web/index.html` script parse;
- focused IPTV/P9 tests;
- focused fast VOD startup/P14 tests;
- focused subtitles/CC/P11 tests;
- full `npm.cmd test`;
- isolated `/api/server` runtime smoke;
- household live smokes against the running app (`TRIBOON_USER` +
  `TRIBOON_PASS` or `TRIBOON_TOKEN`): movie + episode play/seek/resume/CC,
  IPTV web remux + native first-byte retune (skips radio), and overlapping
  Play. Override titles with `TRIBOON_VERIFY_MOVIE` /
  `TRIBOON_VERIFY_EPISODE`. `-SkipHouseholdLive` finishes as incomplete;
- Android lint, native JVM unit tests, and debug build;
- Android TV stress smoke when an ADB device is available or supplied.
  Live TV start prefers a video channel and fails if it still lands on radio
  while TV channels exist.

The script prints a **Live coverage** scoreboard at the end so leftover
Windows GPU, web click-through, and episode-handoff rows stay visible.

The Android stress step is part of the full gate. If no Android device is
available, the gate fails. If the runner explicitly skips it, the script still
finishes as incomplete and Android ExoPlayer must be reported as unverified.
The required ADB device must be online and fully booted before the command
starts; this is checked before the longer repository gates. After installing
the APK, stress also requires the app's configured server to be reachable and
the Android app to be signed in with a profile selected. Setup, login, profile,
or PIN screens stop the run as environment preflight failures instead of being
misreported as page, IPTV, buffering, or VOD regressions.

## Required Live Smokes

Automated tests cannot prove real provider playback. For playback-adjacent
changes, complete these live checks before saying the update is done:

| Area | Required proof |
| --- | --- |
| Web Player VOD | Movie starts, seeks, pauses, resumes, closes, and does not show new console errors. |
| Web Player TV episode | Correct season/episode context, resume target, Up Next behavior when relevant. |
| Episode handoff (web + Android) | Manual Play Next, autoplay at EOF, and player episode-strip selection keep the old frame or branded player loader topmost; the TV-show details page never appears between episodes. Autoplay uses the final pre-EOF 10-second choice window and does not start another countdown at EOF. Back during Preparing cancels the pending handoff permanently; stale success/error/native callbacks cannot reopen or close a newer player. |
| Nested page Back (web + Android) | Visit Movie A -> Related B -> Cast -> Related C. Visible Back, browser Back, Escape/Backspace, and Android/TV hardware Back unwind C -> Cast -> B -> A -> the originating browse page, one page per press. A deep-focused person filmography must leave the person page immediately; a direct deep link with no prior in-app page uses the safe origin fallback. |
| Web Live TV | Channel starts in Triboon's web player, retunes cleanly, and shows live-specific errors instead of a generic external-player panel. |
| Android ExoPlayer VOD | Movie or episode opens the native branded loader and ExoPlayer surface, not the web video shell; seek does not show the full startup loader. |
| Player About (web + Android + Windows) | From a playing movie, About opens the in-player card (not the details page), shows billed people, closes, and leaves playback running. Shows hide About. Android uses the native About overlay. Windows catalog uses the same web About card; native Windows chrome About is still unverified. |
| Continue Watching source recovery (web + Android) | Resume an episode on a source made blocked/unresponsive after the watch point was saved. A blocked health verdict advances promptly; an unknown stall retries the same source once, then selects a different ranked release. Playback remains on the same episode and absolute timestamp, never visits show details, and never invokes next episode unless EOF is reached. |
| Android ExoPlayer Live TV | Native Live TV uses ExoPlayer, survives at least 20 Up/Down zaps, and logcat has no fatal/provider-loop markers. |
| Windows native VOD | On Windows 10/11 x64, an H.264 1080p title and HEVC Main10 4K title open the dedicated libmpv surface. Start, pause/resume, seeks/skips, fullscreen, close, direct/remux/transcode fallback, and a simulated sustained stall remain responsive. Diagnostics name the actual decoder; claim GPU only when `hwdec-current` is hardware-backed while frames advance. |
| Windows episode/resume | Saved resume opens at the correct absolute position. Manual next, autoplay at EOF, and episode-strip selection reuse the native surface without revealing details. Close/error/final checkpoint reaches Continue Watching promptly and stale token callbacks cannot change the replacement episode. |
| Windows subtitles/audio/input | VTT selection/version/sync/size and audio-track switching do not restart or desync video. Mouse, keyboard, media keys, fullscreen, Back, and D-pad/controller navigation work at normal and high-DPI scales. |
| Windows native Live TV | Provider HLS and TS plus server fallback start in libmpv; at least 20 rapid zaps release/replace the old stream without stale playback or fatal logs. |
| CC/subtitles | Web and native CC choices open; recommended row is sane; captions stay in-frame; sync/version changes do not restart video or reset captions to time zero. |
| Fast startup | A warm prepared movie or episode starts through the reuse path, not a repeated search/probe/mount/health gate. Healthy warm sources should stay near the 1-2 second target. |
| Warm next episode | At 90 seconds remaining, the exact next S/E is prepared once. Manual/autoplay next joins that work and the prewarmed local lookup; it does not repeat the indexer/NZB/mount path. Out-of-order metadata from an older episode cannot replace the current player's next target. |

If a live smoke cannot run, the final report must say `not run`, explain why,
and describe the risk. `verify:full` now runs the household stream-path
smokes (VOD play/seek/resume/CC, IPTV retune, overlapping Play) when login
env is set. It still cannot click the web player UI, prove Windows GPU
decode, or walk episode-handoff / nested Back / Continue Watching source
recovery — those rows stay owner-run.

### Guided live self-test (real provider, measured)

The dev box has no usenet creds by design, so the automated suite proves engine
logic on mock NNTP only. To measure the real press→frame→seek→resume path on a
configured box (the owner's server or unraid), run the guided self-test against
a running server:

```powershell
$env:TRIBOON_USER="owner"; $env:TRIBOON_PASS="..."
npm.cmd run verify:live -- --base http://localhost:7777 `
  --quality 4k --resume-frac 0.45 `
  --title "Movie Name 2024|tt1234567" --title "Show S01E01|tt7654321|1|1"
```

It logs in, then for each title measures: **ready** (press→playable via
`/api/play`), **1stByte** (stream Range at the requested Continue Watching
offset, or byte 0 for a fresh play), **seek** (a different cold Range),
**resume** (second Play reuses the live
mount), and reports the **playback method** (direct / +aacSafe / remux /
transcode) and a live **health** verdict. Exit code is non-zero if any title
fails to produce a playable stream. Budgets default to feels-local targets
(ready≤3s, 1stByte≤1.5s) and flag `SLOW` rather than hard-failing on timing.

### Latest Evidence

2026-08-26, v3.1.15 ship — Next Episode 1080p/4K/local, Trakt leftover push:

- Version contract: `package.json` 3.1.15; Android `versionName` 3.1.15 /
  `versionCode` 360; Windows client package/Tauri/Cargo 3.1.15.
- Next Episode inherits 1080p/4K. Usenet next-episodes warm `/api/prepare`
  two minutes before the end. Local-library next-episodes skip that warmup
  (the file is already on the server) and stay hot so Play Next does not
  flash Finding source.
- Restart remount holds the last frame and resumes the same source. Weekly
  next-up uses a 2h TMDB season TTL, local calendar day, and a 30-minute
  Home cache.
- Trakt Sync now exports leftover local watched (`/sync/history`) and
  in-progress (`/scrobble/stop`) before the pull. Local-only and already
  imported rows stay out.
- `npm.cmd run verify:full` against this repo on `http://127.0.0.1:7801`
  (house install stayed on 7777) and emulator `emulator-5554` (not the
  Shield). Node suite **664/664**. Isolated `/api/server` 3.1.15.
- Household VOD Mario 4K + FROM S01E01 play/seek/resume/CC PASS (Mario
  ready 4760ms SLOW, then first-byte/seek/resume OK; FROM ready 8079ms
  SLOW, seek 2720ms SLOW, resume 19ms). IPTV web+native retune PASS
  (8185 channels). Overlapping Play PASS (both ready in 41ms). Android
  lint/unit/debug build PASS. Android ExoPlayer stress on `emulator-5554`
  PASS. Windows GPU not instrumented.

2026-08-26, Trakt two-way sync (watched + in-progress, no version bump):

- Gap: Sync now / 6h tick only pulled Trakt down and retried the failed
  scrobble outbox. Leftover local watched/in-progress (watched before
  linking) never went up.
- Fix: `traktSyncDown` now exports leftover local watched via `/sync/history`
  and in-progress via `/scrobble/stop`, then pulls history + playback +
  watchlist. Failed pulls throw instead of looking like "0 imported".
- Live scrobbles/✓ still push immediately. Local wins on pull. Caps: 600
  watched + 40 in-progress per sync.
- Tests: phase2 Trakt unit 4/4; phase4 Trakt audit contract; security
  suite **125/125** including pre-link push + pull of watched and
  in-progress. `verify:full` not run (not a ship).
- Example: you finished a movie in Triboon last week, then linked Trakt.
  Sync now sends that movie up, then brings Trakt's other history back.

2026-08-26, v3.1.14 ship — phone/tablet catalog, opt-in server debug logging:

- Version contract: `package.json` 3.1.14; Android `versionName` 3.1.14 /
  `versionCode` 359; Windows client package/Tauri/Cargo 3.1.14.
- Phone and tablet catalog hide the leftover backdrop still. Details Play
  stays one full-size left row. Landscape trailer is a large left player
  with Play on the right. Spotlight focus does not zoom those pills.
- Server debug logging is off by default. Settings → Engine → Debug
  logging or `TRIBOON_DEBUG=1` writes extra `[debug]` Play / prepare /
  stop / sweep lines. Tokens and passwords are redacted.
- `npm.cmd run verify:full` against this repo on `http://127.0.0.1:7799`
  (house install stayed on 7777) and emulator `emulator-5554` (not the
  Shield). Node suite **660/660**. Isolated `/api/server` 3.1.14.
- Household VOD Mario 4K + FROM S01E01 play/seek/resume/CC PASS (Mario
  ready 5362ms SLOW, then first-byte/seek/resume OK; FROM ready 2343ms).
  IPTV web+native retune PASS (8185 channels). Overlapping Play PASS
  (both ready in 34ms). Android lint/unit/debug build PASS.
- First Android ExoPlayer stress CDP timed out right after APK install.
  Same stress script retry on `emulator-5554` PASS (native Live TV zaps,
  Mario 1080p ExoPlayer seek/About/CC). Windows GPU not instrumented.

2026-08-26, phone/tablet catalog + opt-in server debug logging (no version bump):

- Phone/tablet catalog hides the leftover backdrop still. Details Play stays
  one full-size left row. Landscape trailer is a large left player with Play
  on the right. Spotlight focus no longer zooms those pills (Music tiles
  stay on their own no-scale rule).
- Server debug logging is off by default. Settings → Engine → Debug logging
  or `TRIBOON_DEBUG=1` writes extra `[debug]` Play / prepare / stop / sweep
  lines. Tokens and passwords are redacted.
- Focused: debug redact + settings toggle, phone layout, Android native
  chrome. Full Node suite **660/660**. Isolated `/api/server` 3.1.13.
- Household VOD Mario 4K + FROM S01E01 play/seek/resume/CC PASS (first FROM
  run socket-hung during the full gate; retry OK). IPTV web+native retune
  PASS. Overlapping Play PASS. Android ExoPlayer stress on `emulator-5554`
  PASS. Windows GPU not instrumented. Not tagged.

2026-08-26, v3.1.13 ship — Windows chrome hide, library Continue Watching, leftover mounts:

- Version contract: `package.json` 3.1.13; Android `versionName` 3.1.13 /
  `versionCode` 358; Windows client package/Tauri/Cargo 3.1.13.
- Windows fullscreen chrome now hides. Progress ticks no longer restart the
  2.4s hide timer. Mouse jitter while chrome is up is ignored; after hide,
  a 24px move brings it back. Cursor hides with the overlay.
- Leaving a personal-library title writes Continue Watching immediately.
  Home paints from that dirty cache. CW cards play the disk file; unmatched
  library-only items toast instead of usenet. Matched TMDB titles still
  fall through to Play.
- Overlapping Plays keep an active mount for 45s so a second Play cannot
  404 the first remux. Android 404s on a dead VOD URL report
  `mount not found` so web remounts.
- `npm.cmd run verify:full` on emulator `emulator-5554` (not the Shield):
  IPTV/P9, CC/P11, and isolated `/api/server` 3.1.13 pass. Node suite
  **658/658**. Household VOD play/seek/resume/CC pass (Mario ready 4316ms
  SLOW, FROM ready 1495ms). IPTV web+native retune pass. Overlapping Play
  pass (FROM first-byte 10ms, Mario 12ms, both remux). Android ExoPlayer
  stress PASS. Windows GPU not instrumented.

2026-08-26, v3.1.12 ship — Windows windowed play, web-paced loader, HLS live:

- Version contract: `package.json` 3.1.12; Android `versionName` 3.1.12 /
  `versionCode` 357; Windows client package/Tauri/Cargo 3.1.12.
- Windows Play stays windowed. Exclusive fullscreen is only F / the
  fullscreen button. Closing the guide also returns windowed.
- Windows startup load line uses the same stages and 650/1400/2200/3000
  timing as web (hot Play starts at Mounting). The lane no longer restarts
  on ready/paused blips before the first picture.
- Native overlay shows title + episode, not the `.mkv` filename. Buffer and
  played share the same seek track.
- Native HLS playlists rewrite relative child URIs against the upstream URL
  so channels such as Iran International resolve instead of 404ing on
  `127.0.0.1:7777`.
- Personal-library Continue Watching paints the local file immediately.
  Home art/update and chrome hide leftovers stay on the same web surface.
- `npm.cmd run verify:full` on emulator `emulator-5554` (not the Shield):
  IPTV/P9, CC/P11, and isolated `/api/server` 3.1.12 pass. First full-suite
  run failed one extract (`nativeOverlaySource` missing from the Trakt
  resume eval); after the helper was included, Node suite **656/656** and
  the P14 focused phase4 pattern pass. Household VOD play/seek/resume/CC
  and IPTV web+native retune pass. Overlapping Play still 404'd the FROM
  remux while Mario 4K remuxed (same leftover-mount class as v3.1.11).
  Android ExoPlayer stress PASS. Browser Home/Movies/Live TV/Music pages
  load. Windows GPU not instrumented.

2026-08-26, v3.1.11 ship — in-app Windows update, hide the wrong platform:

- Version contract: `package.json` 3.1.11; Android `versionName` 3.1.11 /
  `versionCode` 356; Windows client package/Tauri/Cargo 3.1.11.
- Prefs → Profiles shows the installer for this device only. Android still
  installs `triboon.apk`. Windows shows the client (and the server for
  admins). Mac/Linux browsers keep the APK download.
- The Windows client downloads the official GitHub latest-download exe,
  checks `SHA256SUMS.txt`, then opens the normal installer UI. Not silent.
- Play search can use TMDB original/aka titles as extra indexer queries.
  The verifier stays on the catalog title.
- One IPTV surface does not keep a leftover linger on a different channel.
- `npm.cmd run verify:full` on emulator `emulator-5554` (not the Shield):
  IPTV/P9, engine, pipeline, player, security focused gates pass; Node suite
  **653/653** after isolating leftover ALASS_PATH so the absent-sidecar test
  stays inert. Isolated `/api/server` 3.1.11. Household VOD
  play/seek/resume/CC and IPTV web+native retune pass. Overlapping Play
  still 404'd the FROM remux while Mario 4K remuxed (same leftover-mount
  class as v3.1.10). Android ExoPlayer stress PASS. Windows GPU not run.

2026-08-26, v3.1.10 ship — resume parks the file, trailers stay in-app:

- Version contract: `package.json` 3.1.10; Android `versionName` 3.1.10 /
  `versionCode` 355; Windows client package/Tauri/Cargo 3.1.10.
- Continue Watching / Back parks the VFS so Resume joins the live mount.
  Play does not wait on indexer search when that mount is ready. A 4K Play
  will not join a 1080 leftover parked under the 4K key.
- Trailers play in our `<video>` via yt-dlp (Vimeo first, then YouTube 720).
  Trailer Play starts the movie, not the clip.
- Auto starts a fresh Play at 10 sockets even if a tiny file is already
  cached. A finished small file still drips to 4 after the startup window.
- Play Next / Up Next / autoplay still share `playNextEpisode()` and the
  last-two-minute prepare. Episode handoff was not re-clicked on the TV.
- `npm.cmd run verify:full` on Shield `10.1.20.11`: focused IPTV/P9 47,
  engine 51, pipeline 8, player 25, security 7; full Node suite **645/645**;
  isolated `/api/server` 3.1.10; household VOD/IPTV pass. Overlapping Play
  404'd on leftover mounts still served by the installed v3.1.9 service.
  Android ExoPlayer stress: WebView CDP did not attach after the debug APK.
  Windows GPU not run.

2026-08-25, trailer player — no YouTube iframe, age-gate uses yt-dlp:

- Trailers still come from TMDB `/videos`. Playback is a same-origin
  `<video>` via `/api/trailer/:id` + `/api/trailer/stream/:id` (yt-dlp,
  Music cookies, one android client, one muxed file). Age-restricted
  embeds that said "watch on YouTube" no longer use that iframe.
  Mint starts yt-dlp in the background so "Loading trailer" is not a
  5s DASH remux wait. If TMDB has Vimeo, that file (up to 1080) plays
  first; otherwise YouTube 720/360. Vimeo fail falls through to YouTube.
- If the top trailer fails, the next TMDB Trailer/Teaser is tried.
- `node --test test/phase4.test.js test/security.test.js`: **193/193**.
- Cold Matrix trailer resolve (`vKQi3bBA1y8`) was **1.9s** after dropping
  the DASH remux / extra YouTube clients. A second resolve is cache-hit.
- Local `http://127.0.0.1:7799/api/trailer/AAAAAAAAAAA` returns 401
  (route exists). Served HTML has `<video>` and no `youtube.com/embed`.
- Shield `10.1.20.11` still hits the installed Windows service on
  `:7777` (this box cannot stop/replace that service). Owner must
  restart that service from this repo, or open a trailer on `:7799`.
- Web Player VOD / IPTV / ExoPlayer live smokes: **not run** (trailer
  modal only).

2026-08-25, v3.1.9 ship — stall stays on the file, 4K stop frees 1080 Play:

- Version contract: `package.json` 3.1.9; Android `versionName` 3.1.9 /
  `versionCode` 354; Windows client package/Tauri/Cargo 3.1.9.
- A wifi/throttle stall retries the same NZB. Only health `blocked` or a
  Sources pick changes release.
- Stop after 4K no longer keeps that mount in the 120s viewer grace.
  Hop evicts. Back-to-details parks it (no 4K sockets). 1080 Play drops
  the leftover 4K warm mount. A provider 502 shrinks the pool instead of
  opening more sockets.
- `npm.cmd run verify:full` on `emulator-5554` (TV): focused IPTV/P9 50,
  engine 42, pipeline 45, player 8, security 25, P11 31; full
  Node suite **630/630**; isolated `/api/server` 3.1.9; household
  VOD/IPTV/overlapping Play; Android ExoPlayer stress `ok: true`.
  Windows GPU not run.

2026-08-25, v3.1.8 ship — pause/resume keeps the same ExoPlayer:

- Version contract: `package.json` 3.1.8; Android `versionName` 3.1.8 /
  `versionCode` 353; Windows client package/Tauri/Cargo 3.1.8.
- Pause, a dropped HTTP range, or a remux `ENDED` while paused no longer
  releases ExoPlayer. Play resumes in place. The first OK opens chrome only.
- Emulator `emulator-5554` remount matrix: FROM S01E10 pause 5s and 60s,
  seek +30/−30, first OK, hop to Mutiny. Same file. No second
  `ExoPlayerImpl: Init` / `Native VOD buffer profile`.
- Season chips on a show keep the episode you left: episode 7, Up to
  Season 2, Down lands on episode 7 again.
- Discover Back is two steps when focus is not on the first card. The
  Android stress gate now presses Back twice in that case.
- `npm.cmd run verify:full` on `emulator-5554` (TV): focused IPTV/P9 50,
  engine 41, pipeline 43, player 8, security 24, P11 31; full
  Node suite **625/625**; isolated `/api/server` 3.1.8; household
  VOD/IPTV/overlapping Play; Android ExoPlayer stress `ok: true`.
  Windows GPU not run.

2026-08-25, v3.1.7 ship — hop Play frees mounts, 4K stays on one file:

- Version contract: `package.json` 3.1.7; Android `versionName` 3.1.7 /
  `versionCode` 352; Windows client package/Tauri/Cargo 3.1.7.
- Leaving a title or starting another Play releases the old session so
  the next title has provider connections. Smash Play on Details joins
  the page warm-up. A later successful Play clears the leftover toast.
- Shield: Mutiny and Don’t Say Good Luck joined prepare in ~3s. Return
  of the King 4K mash/pause 30s/seek/10-minute hold kept the same
  2160p file (recovery 0). Back then FROM started.
- `npm.cmd run verify:full` on `emulator-5554` (TV): focused IPTV/P9 50,
  engine 41, pipeline 43, player 7, security 24, P11 31; full
  Node suite **624/624**; isolated `/api/server` 3.1.7; household
  VOD/IPTV/overlapping Play; Android ExoPlayer stress `ok: true`.
  Windows GPU not run.

2026-08-24, v3.1.6 ship — Up Next file clock + Settings tab recede:

- Version contract: `package.json` 3.1.6; Android `versionName` 3.1.6 /
  `versionCode` 351; Windows client package/Tauri/Cargo 3.1.6.
- Next uses the playing file, not the TMDB hour. A 42-minute episode
  in a 60-minute listing shows Next ~70s before the file ends.
- Browser, phone, and Android phone Settings tabs recede to 46% /
  selected 58% / focus 82%. TV keeps the hard 0.26 D-pad dim.
- `npm.cmd run verify:full` on `emulator-5556` (TV): focused IPTV/P9 50,
  engine 41, pipeline 43, player 7, security 21, P14 21, P11 31; full
  Node suite **615/615**; isolated `/api/server` 3.1.6; household
  VOD/IPTV/overlapping Play; Android ExoPlayer stress `ok: true`.
  Windows GPU not run. Stress keeps a signed Shield install instead of
  overwriting it with a debug APK.

2026-08-24, Up Next used the TMDB hour, not the file:

- A 42-minute episode in a 60-minute listing waited until EOF to show
  Next. A file that matched the listing still showed at last 2.8%.
- Chip + 10s countdown + next-ep prepare now use the playing file
  clock. Seek bar can stay TMDB-padded so remux-so-far is not 100%.
- Contract: 42-minute file / 60-minute listing shows Next ~70s before
  the file ends. Remux-so-far mid-title still hidden. Episode handoff
  + near-end prepare tests passed.

2026-08-24, v3.1.5 ship — press-play sources + 4K Up Next:

- Version contract: `package.json` 3.1.5; Android `versionName` 3.1.5 /
  `versionCode` 350; Windows client package/Tauri/Cargo 3.1.5.
- Scoring: `1080p.HC.V2` is a cam (below auto-play). Unverified remux
  and 1080p HEVC lose to WEB-DL H.264. `unmappable` is a demotion, not
  7z. A 4K Play fans out an extra `2160p` indexer query.
- Oak Street: Play says no playable releases (cams only).
- FROM S01E01 4K mounted `TEPES 2160p WEB-DL` (not MeGusta). Up Next
  last 2.8% (83s remaining, lead 89s) on Chrome, Android TV emulator,
  and phone emulator (remux). Owner accepted emulator as the Android
  gate. Shield 4K not run.
- iPhone/iPad Safari 1080p FROM Up Next proven earlier this day.
- Windows native GPU: not run.
- `npm.cmd run verify:full` on `emulator-5556` (TV) after wake + 45s
  WebView wait: focused IPTV/P9 50, engine 41, pipeline 43, player 7,
  security 21, P14 21, P11 31; full Node suite **615/615**; isolated
  `/api/server` 3.1.5; household VOD/IPTV/overlapping Play; Android
  ExoPlayer stress `ok: true`. Windows GPU not run.

2026-08-23, v3.1.4 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.1.4; Android `versionName` 3.1.4 /
  `versionCode` 349; Windows client package/Tauri/Cargo 3.1.4.
- iPhone Safari: login types, Fullscreen is on-screen, Live TV remuxes
  TS (A&E played on TestingBot iPhone 13 session 1264397). Native
  `/api/iptv/native` is never treated as HLS.
- Android phone: Settings Dashboard tap is not the burger; tabs readable.
- Windows login: password is trimmed; lockout shows the 429 text, not
  "wrong password"; double Enter+click does not burn the limiter.
- Dashboard hours use real play seconds. Native remux ENDED reports
  the real clock, not forced 100%.
- `npm.cmd run verify:full` passed on `emulator-5554` with household
  VOD/IPTV/overlapping Play and Android ExoPlayer stress. TV emulator
  WebView did not paint; Shield was not used for this gate.

2026-08-23, real iPhone 13 Safari full pass (TestingBot, not shipped):

- Device: iPhone 13 / iOS 18.5 Safari via TestingBot session 1264337
  through the Cloudflare tunnel. Hard-reload picked up `iosPhone`.
- Login: stayed signed in after reload. Detail (Spider-Noir) loaded.
- Settings: owner → Dashboard stayed on Dashboard. Tabs readable.
- VOD: Continue S01E02 played HLS (`/api/hls/...`), readyState 4,
  1924×1040, clock advanced (17s). Portrait letterbox, frames moving.
- Fullscreen control: before the fix, `#fsBtn` sat at x=540 on a 390px
  phone (off the right edge). After reload it is in `.osdRight` at
  x=221 y=14 (on screen). Landscape fullscreen already worked when the
  owner rotated. A scripted click cannot enter iOS native fullscreen
  (Safari needs a real finger tap).
- Live TV: fail. A&E and Animal Planet both set
  `/api/iptv/native/…?alt=1` and Safari said "Media failed to decode".
  Those URLs are TS, not HLS. iPhone still has no working Live path
  for these channels.
- Contract test passed. Full `verify:full` not run.

2026-08-23, iPhone player Fullscreen was off-screen (not shipped):

- iPhone Safari is not `mobileShell`, so the player used the desktop
  3-column bar. CC / audio / quality / mute filled the only visible
  slice. Fullscreen sat off the right edge.
- iPhone-only: tag `iosPhone`, move `#fsBtn` into the top-right chrome,
  and use the compact scrolling bar. Desktop / TV / Android keep the
  existing Fullscreen spot.
- Contract: `iOS phone browser: login keys, video fullscreen, and Live HLS
  stay off Android/desktop paths` should pass. Hard-reload the TestingBot
  iPhone to pick up live HTML. Full `verify:full` not run.

2026-08-23, iPhone login password hides the software keyboard (not shipped):

- Name on real iPhone 13 Safari typed from the iOS keys. Password
  focused (gold ring, Done, Paste/AutoFill) and hid the QWERTY keys.
- iOS-only: login password uses `inputmode="text"` and turns off
  AutoFill (`autocomplete=off`). Desktop/TV keep keychain fill.
- Contract: `iOS phone browser: login keys, video fullscreen, and Live HLS
  stay off Android/desktop paths` passed. Reload the TestingBot iPhone
  to pick up live HTML. Full `verify:full` not run.

2026-08-23, Android phone Settings Dashboard tap + readable tabs (not shipped):

- Phone Settings Dashboard sat in the old 132px burger corner. A tap
  opened the left menu and ate the tab click. Burger hit now ignores
  real controls and only uses a 72px empty-chrome zone.
- Phone Settings tabs no longer use the TV 0.26 recede. Open drawer
  rows use normal text color. TV D-pad dimming is unchanged.
- Contract: `Android phone: Settings Dashboard tap is not the burger,
  and tabs stay readable`. Verify on `Triboon_Phone_API_36`.
- Full `npm.cmd test` / `verify:full` not run for this local web change.

2026-08-22, iPhone Safari/Chrome web-player gates (not shipped):

- Login typing, fullscreen, and Live TV on iPhone are gated behind
  `iosWebkitVideo()` only. Android ExoPlayer `playLive`, desktop/Windows
  MSE remux, and `#player.requestFullscreen` are unchanged.
- Contract: `iOS phone browser: login keys, video fullscreen, and Live HLS
  stay off Android/desktop paths` plus D-pad auth-input and IPTV cache
  suites passed. Real iPhone Safari/Chrome not run (no device here).
- TS-only live channels still have no iPhone path until a live HLS remux
  exists. BrowserStack or a cheap used iPhone is the later A-to-Z gate.
- Full `npm.cmd test` / `verify:full` not run for this local web change.

2026-08-21, v3.1.3 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.1.3; Android `versionName` 3.1.3 /
  `versionCode` 348; Windows client package/Tauri/Cargo 3.1.3.
- Live TV is an ink page like Settings: leftover Movies/TV backdrop
  image and `#bdInfo` title text are cleared, and rail preview does not
  paint the last movie still behind the channel list.
- In-player IPTV guide **Back to [title]** gets a visible D-pad focus
  fill (inset ring + gold arrow chip) via `applyFocus` / `.pgBackTop.focus`.
- Android testing for this ship used the local TV emulator
  (`emulator-5554`), not the living-room Shield.
- `npm.cmd test` 604/604. Isolated `/api/server` smoke reported 3.1.3.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC, IPTV
  (24484 channels, 2 video picks), overlapping Play 18ms / 2053ms wall,
  Android lint/native-unit/`assembleDebug`, and emulator ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260821-084849.json`
  (`ok: true`; emulator 4K LOTR empty-search warning only).
- Household Mario: ready 5141ms SLOW, first-byte 2635ms SLOW, seek 602ms,
  resume 39ms, remux, cc=200. FROM S01E01: ready 2128ms, first-byte 196ms,
  seek 1224ms, resume 10ms, remux, cc=200.
- Windows native GPU/HDR not run.

2026-08-20, v3.1.2 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.1.2; Android `versionName` 3.1.2 /
  `versionCode` 347; Windows client package/Tauri/Cargo 3.1.2.
- Watch Activity names (moe / Toomaj / Naderi) are real buttons: click
  jumps to Users and opens that account's watch peek. Toomaj gold/green
  hover fill is gone on those names. Recently-watched tiles with no
  poster stay a quiet ink square, not a yellow-green blob.
- Settings / Preferences sit on clean ink — the last Home/Movies still
  does not ride in.
- In-player Live TV "Back to <title>" resumes the movie or show you left
  on the first click (web, Android ExoPlayer, Windows libmpv). Opening the
  guide from a title saves it; picking CNN no longer freezes the button
  as Close guide.
- Android testing for this ship used the local TV emulator
  (`emulator-5554`), not the living-room Shield.
- `npm.cmd test` 604/604. Isolated `/api/server` smoke reported 3.1.2.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC, IPTV ABC+ESPN
  web+native (24484 channels, 2 video picks), overlapping Play 2122ms /
  4165ms wall, Android lint/native-unit/`assembleDebug`, and emulator
  ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260821-050323.json`
  (`ok: true`).
- Household Mario: ready 1034ms, first-byte 2ms, seek 1ms, resume 15ms,
  remux, cc=200. FROM S01E01: ready 23261ms SLOW, first-byte 4ms, seek
  1ms, resume 4ms, remux, cc=200.
- Windows native GPU/HDR not run.

2026-08-20, v3.1.1 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.1.1; Android `versionName` 3.1.1 /
  `versionCode` 346; Windows client package/Tauri/Cargo 3.1.1.
- Shield TV polish: Home 1-row window sizes to the focused row so Live TV
  no longer peeks chopped posters; Live TV search/channels sit 16px above
  the guide; in-player About uses details-page 3:4 faces (web + native)
  that fit all 10 billed people; Sources is a hairline list with no card
  fill — the row you are on grows bright, no left tick (the scroller was
  clipping it).
- `npm.cmd test` 604/604. Isolated `/api/server` smoke reported 3.1.1.
  `npm.cmd run verify:full -- -AndroidDevice 10.1.20.11:5555
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC, IPTV ABC+ESPN
  web+native (24484 channels, 2 video picks), overlapping Play 15ms /
  1250ms wall, Android lint/native-unit/`assembleDebug`. A follow-up
  Shield ExoPlayer stress (no reinstall after the debug APK was already
  on the box) passed
  `bench/stress-results/android-tv-stress-20260820-221954.json`
  (`ok: true`). The same `verify:full` install+stress pass had already
  succeeded earlier in
  `bench/stress-results/android-tv-stress-20260820-220716.json`; a second
  install raced Home with 0 cards, so the boot wait is now 60s.
- Household Mario: ready 1629ms, first-byte 92ms, seek 4ms, resume 20ms,
  remux, cc=200. FROM S01E01: 1108/24/3/64ms, remux, cc=200.
- Windows native GPU/HDR not run.

2026-08-20, v3.1.0 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.1.0; Android `versionName` 3.1.0 /
  `versionCode` 345; Windows client package/Tauri/Cargo 3.1.0.
- Watch dashboard uses real `/api/watch-stats` only. Sample/demo overlay
  (`DASH_DEMO`, fake posters) is gone. `DASH_TRIAL` stays on for real
  extras (streak, weekday/weekend, Just finished). Admin click-name opens
  that user's status peek. People tab skips the signed-in user's covers
  and shows full titles. Browser About / episode strip close on click-away
  without toggling play. Just finished posters no longer get a gold click
  frame.
- `npm.cmd test` 604/604. Isolated `/api/server` smoke reported 3.1.0.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC, IPTV ABC+ESPN
  web+native (24484 channels, 2 video picks), overlapping Play 16ms /
  165ms wall, Android lint/native-unit/`assembleDebug`, and ExoPlayer
  stress `bench/stress-results/android-tv-stress-20260820-155915.json`
  (`ok: true`; emulator LOTR empty-search warning only).
- Household Mario: ready 986ms, first-byte 628ms, seek 141ms, resume 18ms,
  remux, cc=200. FROM S01E01: 6393ms SLOW / 63 / 8 / 1061ms SLOW, remux,
  cc=200. Live household process still reported v3.0.13 until restart.
- Windows native GPU/HDR not run.

2026-08-20, v3.0.13 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.13; Android `versionName` 3.0.13 /
  `versionCode` 344; Windows client package/Tauri/Cargo 3.0.13.
- In-player About wash is a notch darker so opening credits stay readable.
  Web About no longer hides the controller bar; the card sits above
  play/seek, and About toggles closed. Music first Back opens the rail even
  when leftover zone says rail but the menu is closed.
- `npm.cmd test` 597/597. Isolated `/api/server` smoke reported 3.0.13.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC, IPTV web+native,
  overlapping Play 14ms / 493ms wall, Android
  lint/native-unit/`assembleDebug`, and ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260820-122355.json`
  (`ok: true`; emulator LOTR empty-search warning only).
- Household Mario: ready 988ms, first-byte 225ms, seek 47ms, resume 15ms,
  remux, cc=200. FROM S01E01: 568/35/101/67ms, remux, cc=200.
- Windows native GPU/HDR not run.

2026-08-20, v3.0.12 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.12; Android `versionName` 3.0.12 /
  `versionCode` 343; Windows client package/Tauri/Cargo 3.0.12.
- Cold 0:00 remount no longer treats Exo `ENDED` at duration as credits, so
  Mario is not marked watched 6065/6065. Empty indexer fan-out does not
  overwrite a good search cache. Discover Back ignores a leftover Home
  `rowsView`. Leaving Home cancels in-flight home loads so a late row paint
  cannot steal Music focus; first Back on Music opens the rail.
- `npm.cmd test` 597/597. Isolated `/api/server` smoke reported 3.0.12.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC, IPTV web+native
  (24484 channels, 2 video picks), overlapping Play 23ms / 483ms wall,
  Android lint/native-unit/`assembleDebug`, and ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260820-112454.json`
  (`ok: true`; emulator LOTR 1080p-empty/4K-present warning only).
- Household Mario: ready 1011ms, first-byte 161ms, seek 53ms, resume 258ms,
  remux, cc=200. FROM S01E01: 964/117/257/104ms, remux, cc=200.
- Windows native GPU/HDR not run.

2026-08-20, v3.0.11 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.11; Android `versionName` 3.0.11 /
  `versionCode` 342; Windows client package/Tauri/Cargo 3.0.11.
- Android TV Back closes the in-player About/cast card first, then the
  controller bar. Episode About leads with this season's regulars, then
  that episode's billed cast and guests, instead of lifetime show ranking.
  A stray `({)` in the About-cast map froze the web splash; fixed. Native
  player buttons gained a small extra gap (8dp).
- `npm.cmd test` 594/594. Isolated `/api/server` smoke reported 3.0.11.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC, IPTV ABC+ESPN
  web+native, overlapping Play 12ms / 1037ms wall, Android
  lint/native-unit/`assembleDebug`, and ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260820-011047.json`
  (`ok: true`, zero failures/warnings).
- Household Mario 4K: ready 3641ms SLOW, first-byte 898ms, seek 1286ms,
  resume 16ms, remux, cc=200. FROM S01E01: 2058/167/1331/9ms, remux,
  cc=200. IPTV ABC+ESPN web+native. Live household process still reported
  v3.0.10 until restart.
- Windows native GPU/HDR not run.

2026-08-20, v3.0.10 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.10; Android `versionName` 3.0.10 /
  `versionCode` 341; Windows client package/Tauri/Cargo 3.0.10.
- In-player About card: poster, year, runtime, rating, plot, display-only
  cast names. Movies open it on Down. Shows keep episodes first; About is
  a strip tile plus the VOD chrome button next to Guide. Hidden when a
  title has no cast and no crew. Episode About uses that episode's plot.
  Cast names wrap first/last. Lucide gallery-horizontal-end icon.
- Android TV stress no longer pulls the full ~24k-channel playlist through
  WebView `JSON.parse` (that returned `{}`). It starts from favorites /
  `?limit=40` and seeds the in-page Live TV cache so Multiview can open.
  `/api/iptv/channels?limit=N` is capped at 200.
- `npm.cmd test` 594/594. Isolated `/api/server` smoke reported 3.0.10.
  `verify:full` household
  VOD/CC/IPTV/overlap + Android lint/native-unit/`assembleDebug` passed
  against the already-up v3.0.8 process on :7777. ExoPlayer stress retried
  after the lean/fav Live start fix:
  `bench/stress-results/android-tv-stress-20260820-002304.json`
  (`ok: true`, zero failures/warnings).
- Household Mario 4K: ready 940ms, first-byte 131ms, seek 32ms, resume
  12ms, remux, cc=200. FROM S01E01: 563/188/3/40ms, remux, cc=200.
  IPTV ABC+ESPN web+native. Overlapping Play 15ms / 407ms wall.
- Windows native GPU/HDR not run.

2026-08-19, v3.0.9 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.9; Android `versionName` 3.0.9 /
  `versionCode` 340; Windows client package/Tauri/Cargo 3.0.9.
- Play Next now mute/pause/stops the current native remux before
  Preparing, so credits audio cannot hold provider slots. Missing next
  episode or a 50s handoff hang closes the player instead of sitting
  on Preparing until force-close.
- `npm.cmd test` 594/594. Isolated `/api/server` smoke reported 3.0.9.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC (Mario 4K +
  FROM 1080p), IPTV ABC+ESPN web+native, overlapping Play 23ms /
  944ms wall, Android lint/native-unit/`assembleDebug`, and ExoPlayer
  stress `bench/stress-results/android-tv-stress-20260819-203826.json`
  (`ok: true`, zero failures/warnings).
- Household Mario 4K: ready 1114ms, first-byte 4651ms SLOW, seek 28ms,
  resume 52ms, remux, cc=200. FROM S01E01: 8003ms SLOW / 5 / 2 / 735ms,
  remux, cc=200. Household live smokes ran against the already-up
  v3.0.8 process on :7777.
- Windows native GPU/HDR not run.

2026-08-19, v3.0.8 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.8; Android `versionName` 3.0.8 /
  `versionCode` 339; Windows client package/Tauri/Cargo 3.0.8.
- Remux mid-file Range past a short yEnc hole now keeps streaming
  (zero-fill the rest of that part). Play joining a prepared mount
  keeps the full ranked list. Next-episode prepare does not mount a
  standby while the current episode is still playing. After a
  direct episode handoff, same-file remount is quiet for 12s unless
  the source is dead.
- `npm.cmd test` 594/594. Isolated `/api/server` smoke reported 3.0.8.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC (Mario 4K +
  FROM 1080p), IPTV ABC+ESPN web+native, overlapping Play 29ms /
  195ms wall, Android lint/native-unit/`assembleDebug`, and ExoPlayer
  stress `bench/stress-results/android-tv-stress-20260819-163322.json`
  (`ok: true`, zero failures/warnings).
- Household Mario 4K: ready 4530ms SLOW, first-byte 1165ms, seek 350ms,
  resume 70ms, remux, cc=200. FROM S01E01: 1567/361/411/32ms, remux,
  cc=200.
- Windows native GPU/HDR not run.

2026-08-19, v3.0.7 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.7; Android `versionName` 3.0.7 /
  `versionCode` 338; Windows client package/Tauri/Cargo 3.0.7.
- Catalog year + indexer IMDb/TVDB now lock remakes and same-name
  titles. Episode Play uses TMDB year even when `q` is `Show S01E01`.
  A tagged remake NZB is dropped even with no year in the filename.
  Country `.AU` / `.UK` / `.NZ` / `.CA` still need an explicit ask.
  Live: Office US mounts `The.Office.US.2005` Superfan Cut, not 2024.
  A 20-title soak still found and played; only Office source count
  dropped (85→56), on purpose.
- Short labelled 4K stays playable (80MB stub floor). Explicit
  Sources `pick`/`pickKey` mounts only that file. Native rewind is
  30s and `seekTo` drives ExoPlayer/libmpv.
- `npm.cmd test` 589/589. Isolated `/api/server` smoke reported 3.0.7.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, household VOD/CC (Mario 4K +
  FROM 1080p), IPTV ABC+ESPN web+native, overlapping Play 23ms /
  213ms wall, Android lint/native-unit/`assembleDebug`, and ExoPlayer
  stress `bench/stress-results/android-tv-stress-20260819-145931.json`
  (`ok: true`, zero failures/warnings).
- Household Mario 4K: ready 4256ms SLOW, first-byte 1181ms, seek 869ms,
  resume 46ms, remux, cc=200. FROM S01E01: 1470/512/256/14ms, remux,
  cc=200.
- Windows native GPU/HDR not run.

2026-08-19, Play quality / pick / Office / Android rewind (not a version bump):

- Short labelled 4K (Sintel ~180MB) stays playable. A 300MB hard stub
  floor was swapping those Plays to 1080p. 68MB samples still die.
  Indexer-lied MK2 stubs still die when billed ≥2GB and mounted <400MB.
- A Sources `pick`/`pickKey` mounts only that file or fails. It no
  longer walks a smaller WEB-DL (41GB Interstellar IMAX → 15.6GB).
- `The Office` rejects `.AU` / `.UK` / `.NZ` / `.CA` unless the query
  asked for that country. Untagged and `.US` still match.
- Web `seekTo` drives native ExoPlayer/libmpv. Remux/transcode remount;
  direct uses `TriboonTV.seekTo`. Native rewind step is 30s, same as
  forward. Official `android-tv-smoke -VodSmoke` uses a Home movie or
  episode when the default TMDB key is missing.
- Restarted household `http://127.0.0.1:7777` on this tree (still
  reports v3.0.6). `npm.cmd test` 582/582.
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed whitespace, JS syntax, web parse,
  focused P9/P14/P11, full Node suite, isolated `/api/server` 3.0.6
  smoke, household VOD/CC (Mario 4K + FROM 1080p), IPTV ABC+ESPN
  web+native, overlapping Play, Android lint/native-unit/`assembleDebug`,
  and ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260819-140921.json`
  (`ok: true`, zero failures/warnings).
- Household Mario 4K: ready 3604ms SLOW, first-byte 795ms, seek 457ms,
  resume 12ms, remux, health=verified, cc=200. FROM S01E01: 707/265/22/7ms,
  remux, cc=200. Overlap wall 515ms.
- Not re-run as named titles: Sintel 4K stay-4K, Office US vs AU, explicit
  41GB Interstellar pick. Windows native GPU/HDR not run.

2026-08-18, v3.0.6 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.6; Android `versionName` 3.0.6 /
  `versionCode` 337; Windows client package/Tauri/Cargo 3.0.6.
  v3.0.5 was tagged but never published: Cargo.toml had a trailing
  comma and the Windows client job failed. Do not reuse that tag.
- Next Episode uses one file-based window for every show: last 2.8% of
  the playing file, floor 30s, cap 90s. TMDB runtime is only a stub
  check (file must be at least 65% of the listing). Autoplay still
  waits for the last 10s. No per-show list and no 22/30/60 minute
  buckets.
- `npm.cmd test` 572/572. Isolated `/api/server` smoke reported 3.0.5.
  Household VOD/CC (Mario + FROM), IPTV ABC+ESPN web+native, and
  overlapping Play passed. Combined `verify:full` Android ExoPlayer
  Live+VOD+CC on emulator-5554 passed.
- Windows native GPU/HDR was not run (needs a real Windows PC session).

2026-08-17, v3.0.4 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.4; Android `versionName` 3.0.4 /
  `versionCode` 335; Windows client package/Tauri/Cargo 3.0.4.
- Details Play, trailer Play, Play Next, and sitting through the 10s
  autoplay countdown join the same `/api/prepare` mount. They stay on
  the player and skip a cold Finding-source reset. A finished prepare
  is reused even after the 60s search cache expires. Android Next
  covers immediately so the next title does not flash at 00:00.
- `npm.cmd test` 572/572. Isolated `/api/server` smoke reported 3.0.4.
  Household VOD/CC, IPTV ABC+ESPN web+native, and overlapping Play
  passed. Isolated Android ExoPlayer Live+VOD+CC+page-churn on
  emulator-5554 passed. Combined `verify:full` Android stress flaked
  twice after Live TV on Movies/Discover Back. Those combined page-churn
  rows stay unverified on this emulator session.
- Windows native GPU/HDR was not run (needs a real Windows PC session).

2026-08-17, v3.0.3 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.3; Android `versionName` 3.0.3 /
  `versionCode` 334; Windows client package/Tauri/Cargo 3.0.3.
- Next Episode is back as a small chip plus X. It shows in a runtime
  window (sitcom ~20s, 42-min ~32s, hour ~42s, longer ~52s) of a real
  episode end. The 10s autoplay bar sits under the words. Click and
  D-pad work on web, Android, and Windows: Left/Right choose Next/X,
  OK/Enter plays, Back dismisses. The chip sits above the OSD so a
  mouse click is not swallowed by the control overlay.
- `npm.cmd test` 570/570. Isolated `/api/server` smoke reported 3.0.3.
  `npm.cmd run verify:full` passed household VOD/CC, IPTV ABC+ESPN
  web+native, overlapping Play, and Android lint/native-unit/`assembleDebug`.
  Android ExoPlayer VOD+seek+CC passed on emulator-5554 when run alone.
  The combined Live+page-churn+VOD stress flaked twice after Live TV
  (player closed before seeks; later Discover Back). Those combined
  rows stay unverified on this emulator session.
- Windows native GPU/HDR was not run (needs a real Windows PC session).

2026-08-17, v3.0.2 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.2; Android `versionName` 3.0.2 /
  `versionCode` 333; Windows client package/Tauri/Cargo 3.0.2.
- Kids Home and the Kids page still lead with popular Family/Animation
  movies and Kids TV, then weave in recent titles from the last 18
  months. The mix rotates once a day so the shelf is not identical
  every morning. The PG cap is unchanged.
- `npm.cmd test` 569/569. Isolated `/api/server` smoke reported 3.0.2.
  `npm.cmd run verify:full` passed household VOD/CC, IPTV ABC+ESPN
  web+native, overlapping Play, Android lint/native-unit/`assembleDebug`,
  and Android ExoPlayer stress on emulator-5554.
- Windows native GPU/HDR was not run (needs a real Windows PC session).

2026-08-17, v3.0.1 ship APK + Windows server + Windows client:

- Version contract: `package.json` 3.0.1; Android `versionName` 3.0.1 /
  `versionCode` 332; Windows client package/Tauri/Cargo 3.0.1.
- Music now-playing is a centered shrink-wrapped player. Like / Lyrics /
  Radio / Queue keep full labels. Phone title and controls sit under the
  cover. Mid-episode source swaps no longer look like credits.
- `npm.cmd test` 569/569. Isolated `/api/server` smoke reported 3.0.1.
  Android lint/native-unit/`assembleDebug` passed on emulator-5554.
- Household VOD/IPTV/overlapping Play and Android ExoPlayer stress were
  not signed in (no `TRIBOON_USER`/`TRIBOON_PASS` in this session;
  emulator stopped at login). Those live rows stay unverified.
- Owner rule: "ship / new version / do everything" means tag `vX.Y.Z`
  so CI publishes APK + Windows server + Windows client. A code-only
  push is not a release.

2026-08-14, v3.0.0 smash-Play join + Start Over head warm:

- Version contract: `package.json` 3.0.0; Android `versionName` 3.0.0 /
  `versionCode` 331; Windows client package/Tauri/Cargo 3.0.0.
- Smash Play on Details joins the in-flight `/api/prepare` job (narrow
  2-wide race) instead of a second 5-wide hunt. TV Details prepares the
  next episode immediately, not the bare show. Start Over on a
  resume-prepared mount expands to a full 0:00 head warm so beginning
  playback is not a cold seek. Browser and Android TV share this path.
- `npm.cmd test` 568/568. `npm.cmd run verify:full -- -AndroidDevice
  emulator-5554 -AndroidHostServerPort 7777` passed whitespace, JS syntax,
  web parse, focused P9/P14/P11, full Node suite, isolated `/api/server`
  smoke, household VOD/IPTV/overlapping Play, Android
  lint/native-unit/debug build, and ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260814-144808.json` (`ok: true`,
  zero failures/warnings).
- Household live on `http://127.0.0.1:7777`: Mario 4K
  3935ms/523ms/129ms/13ms (ready SLOW, stream OK, English-HONE);
  FROM S01E01 1367ms/126ms/439ms/12ms; overlapping Play 5ms/14ms ready;
  IPTV ABC then ESPN web+native first-bytes OK.
- Owner live: Supergirl (2026) web remux reached a picture after skipping
  dead top picks (x265/missing/failed), then a verified 1080p WEB. That
  wait is source rot, not the double-hunt.
- Unverified on this run: Windows native GPU/HDR, signed-in browser
  click-through, and episode-handoff / nested Back / CW source recovery.

2026-08-14, v2.9.12 phone catalog + per-profile Kids + burger/detail chrome:

- Version contract: `package.json` 2.9.12; Android `versionName` 2.9.12 /
  `versionCode` 330; Windows client package/Tauri/Cargo 2.9.12.
- Phone Movies/TV/Kids/Library/Search show two posters per row (desktop 190px
  covers were stretching to one giant card). Home/Discover row gap is 22px.
  Open-menu burger no longer sits on the profile name. Details drop the 140px
  desktop title slot. Kids show/hide is per profile, not one device-wide switch.
  Screensaver small tiles skip duplicate art. Android TV rail is unchanged.
- `npm.cmd test` 566/566. `npm.cmd run verify:full -- -AndroidDevice
  emulator-5554 -AndroidHostServerPort 7777` passed whitespace, JS syntax,
  web parse, focused P9/P14/P11, full Node suite, isolated `/api/server`
  2.9.12 smoke, household VOD/IPTV/overlapping Play, Android
  lint/native-unit/debug build, and ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260814-124025.json` (`ok: true`,
  zero failures/warnings).
- Household live on `http://127.0.0.1:7777` (v2.9.12): Mario 4K
  4509ms/347ms/224ms/73ms (ready SLOW, stream OK, English-HONE);
  FROM S01E01 2698ms/90ms/187ms/9ms; overlapping Play 3ms/4ms first-byte;
  IPTV ABC then ESPN web+native first-bytes OK.
- Unverified on this run: Windows native GPU/HDR, signed-in browser
  click-through, and episode-handoff / nested Back / CW source recovery.

2026-08-14, Kids page on web/Windows (PG max) + Android rail unchanged:

- Not a version bump. `package.json` stays 2.9.11. Kids is a new left-menu page on
  browser and Windows only. Android (`body.androidApp`) keeps the old rail: no
  Kids button, no Kids row in Preferences → Menu, `#/kids` falls back to Home.
  Kids movies cap at PG (G on a G profile). Kids TV uses TMDB genre 10762.
- Also in this tree: local-library search, folder-info cover revert (strip leftover
  TMDB art, video-frame thumb), and Home Kids as one mixed movie+show shelf.
- `npm.cmd test` 566/566. `npm.cmd run verify:full -- -AndroidDevice
  emulator-5554 -AndroidHostServerPort 7777` passed whitespace, JS syntax,
  web parse, focused P9/P14/P11, full Node suite, isolated `/api/server`
  2.9.11 smoke, and household VOD/IPTV/overlapping Play. First Android
  ExoPlayer stress failed (`VOD was not still playing after seek loop`);
  retry `bench/android-tv-stress.ps1` passed
  `bench/stress-results/android-tv-stress-20260814-111651.json` (`ok: true`).
- Household live on `http://127.0.0.1:7777` (v2.9.11): Mario 4K
  4033ms/587ms/162ms/56ms (ready SLOW, stream OK, English-HONE);
  FROM S01E01 7546ms/448ms/293ms/1083ms (ready+resume SLOW); overlapping Play
  2ms/4ms first-byte; IPTV ABC then ESPN web+native first-bytes OK.
- Unverified on this run: Windows native GPU/HDR, signed-in browser
  click-through, and episode-handoff / nested Back / CW source recovery.

2026-08-13, v2.9.11 Home/Details next-episode + Up Next off + 2-minute prepare:

- Version contract: `package.json` 2.9.11; Android `versionName` 2.9.11 /
  `versionCode` 329; Windows client package/Tauri/Cargo 2.9.11.
- After an episode ends, Home and Details jump to the next episode without
  waiting for a leave/reopen. The in-player Up Next card is off (credits
  length is not guessable). Autoplay starts the next file; off returns to
  the show page. `/api/prepare` for the next episode fires at 120 seconds
  remaining.
- `npm.cmd test` 565/565. `npm.cmd run verify:full -- -AndroidDevice
  emulator-5554 -AndroidHostServerPort 7777` passed whitespace, JS syntax,
  web parse, focused P9/P14/P11, full Node suite, isolated `/api/server`
  2.9.11 smoke, household VOD/IPTV/overlapping Play, Android
  lint/native-unit/debug build, and ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260813-223559.json` (`ok: true`,
  zero failures/warnings).
- Household live on `http://localhost:7777` (v2.9.11): Mario 4K
  4033ms/144ms/615ms/13ms (ready SLOW, stream OK, English-HONE);
  FROM S01E01 2941ms/206ms/613ms/1064ms (resume SLOW); overlapping Play
  8ms/11ms first-byte; IPTV ABC then ESPN web+native first-bytes OK.
- Left out of this ship on purpose: Because-you-watched still seeds from the
  latest Continue Watching card; The Office AU can still win a 4K pick for
  the US show.
- Unverified on this run: Windows native GPU/HDR, signed-in browser
  click-through, and episode-handoff / nested Back / CW source recovery.

2026-08-13, v2.9.10 Lioness title-index merge + year rank + quiet fallbacks:

- Version contract: `package.json` 2.9.10; Android `versionName` 2.9.10 /
  `versionCode` 328; Windows client package/Tauri/Cargo 2.9.10.
- Episode searches that already have a TVDB/IMDb id also fan out a plain
  title query, so Lioness/Lucky WEB-DLs in the title index join the ID-tagged
  leftovers. Year is ranking-only (exact year +20, wrong year after the title
  -250); it never hides a row. BEST sorts by score. Recovery toasts stay
  quiet when the next file already started. Windows libmpv honors preferred
  English audio.
- `npm.cmd test` 565/565. `npm.cmd run verify:full -- -AndroidDevice
  emulator-5554 -AndroidHostServerPort 7777` passed whitespace, JS syntax,
  web parse, focused P9/P14/P11, full Node suite, isolated `/api/server`
  2.9.10 smoke, household VOD/IPTV/overlapping Play, and Android
  lint/native-unit/debug build. First Android stress hit the known
  post-install CDP session-bounce; rerun
  `bench/stress-results/android-tv-stress-20260813-193059.json` is `ok: true`
  with zero failures/warnings (native live zaps, Weapons 1080p remux seeks,
  CC 200).
- Household live on `http://localhost:7777` (v2.9.10): Mario 4K
  4061ms/3225ms/209ms/13ms (ready+first-byte SLOW, stream OK, English-HONE);
  FROM S01E01 8789ms/129ms/429ms/26ms; overlapping Play 10ms/22ms first-byte
  4ms/7ms; IPTV ABC then ESPN web+native first-bytes OK.
- Left out of this ship on purpose: Because-you-watched still seeds from the
  latest Continue Watching card (a 5-minute bounce can still name the row);
  The Office AU can still win a 4K pick for the US show.
- Unverified on this run: Windows native GPU/HDR, signed-in browser
  click-through, and episode-handoff / nested Back / CW source recovery.

2026-08-13, v2.9.9 publication of the 2.9.8 app:

- Version contract: `package.json` 2.9.9; Android `versionName` 2.9.9 /
  `versionCode` 327; Windows client package/Tauri/Cargo 2.9.9.
- Same product as v2.9.8 (English-first Play, TV Search mic pin) plus the
  public README/setup polish. The `v2.9.8` tag CI failed after `main` moved
  during publish, so this tag is the clean GitHub/Unraid ship.
- Live playback evidence is the v2.9.8 `verify:full` pass below. This bump
  does not change engine, player, or IPTV code.

2026-08-13, v2.9.8 English-first Play + Android TV Search mic pin:

- Version contract: `package.json` 2.9.8; Android `versionName` 2.9.8 /
  `versionCode` 326; Windows client package/Tauri/Cargo 2.9.8.
- English-tagged sources beat higher-res French/German/MULTi dubs. Empty
  Preferences audio now means English, not the first track. Owner confirmed
  Lioness no longer opens on `FRENCH` BAWLS after the ranking restart.
- Android TV Search: OK on the left-menu Search item keeps focus on the
  microphone instead of bouncing back to the rail. Contract-tested; owner
  live D-pad check is waiting on the Unraid pull.
- `npm.cmd test` 563/563. `npm.cmd run verify:full -- -AndroidDevice
  emulator-5554` passed whitespace, JS syntax, web parse, focused P9/P14/P11,
  full Node suite, isolated `/api/server` 2.9.8 smoke, household VOD/IPTV/
  overlapping Play, Android lint/native-unit/debug build, and ExoPlayer
  stress `bench/stress-results/android-tv-stress-20260813-135258.json`
  (`ok: true`).
- Household live on `http://localhost:7777` (v2.9.8): Mario 4K
  3934ms/575ms/394ms/13ms (ready SLOW, stream OK, English-HONE WEB-DL);
  FROM S01E01 1433ms/176ms/548ms/43ms; overlapping Play 6ms/12ms; IPTV ABC
  then ESPN web+native first-bytes OK.
- Unverified on this run: owner Android TV Search-mic D-pad on the living-room
  box, Windows native GPU/HDR, and signed-in browser click-through.

2026-08-13, v2.9.7 final production pass (go-live gate):

- `npm.cmd run verify:full -- -AndroidDevice emulator-5554` passed every
  automated gate on the live 2.9.7 server: whitespace, JS syntax, web parse,
  focused IPTV/P9, fast VOD/P14, subtitles/CC/P11, full Node suite 558/558,
  isolated `/api/server` smoke, Android lint/native-unit/debug build, and
  Android ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260813-125504.json` (`ok: true`,
  zero failures/warnings). Stress covered Live TV start, Multiview, PiP,
  zaps, Mario VOD start, Continue Watching, seek loop, and CC (`variants=1`).
- Live household smokes on `http://localhost:7777` (v2.9.7, iptv=true):
  Mario 4K play/seek/resume 930ms/158ms/5ms/36ms; FROM S01E01
  564ms/248ms/5ms/42ms; overlapping 1080p+4K ready 1.4s/2.7s; IPTV ABC then
  ESPN web remux + native first-bytes both OK (24,688 channels).
- GitHub release `v2.9.7` is published with APK, both Windows installers, and
  checksums.
- Unverified on this run: Windows native GPU/HDR client on a real PC, and a
  signed-in browser click-through of the web player (API + remux paths were
  proven instead). Physical Chromecast/Android TV already passed earlier.

2026-08-13, v2.9.7 overlapping Plays, kids search gate, shared web Live TV:

- Version contract aligned: `package.json` 2.9.7; Android `versionName` 2.9.7 /
  `versionCode` 325; all four Windows client version spots 2.9.7.
- Two or three concurrent Plays now share indexer fan-out and a 3-slot startup
  gate so one title's dead-source race cannot starve another Play. Kids search
  and play are profile-gated on the server. Browser Live TV remux joins the
  shared TS hub. Library TMDB matching no longer takes `results[0]` blindly.
- `npm.cmd test` 558/558. `npm.cmd run verify:full -- -AndroidDevice
  emulator-5554` passed whitespace, JS syntax, web parse, focused P9/P14/P11,
  full Node suite, isolated `/api/server` smoke, and Android
  lint/native-unit/debug build. The first Android ExoPlayer stress run failed
  `VOD was not still playing after seek loop` because the emulator still spoke
  to the leftover 2.9.6 process; after restarting `node server/index.js` onto
  2.9.7 (`/api/server` version 2.9.7), the same stress passed
  `bench/stress-results/android-tv-stress-20260813-123248.json` with `ok: true`,
  zero failures, zero warnings, and the recorded 7782 -> 7777 route.
- Live household server is now 2.9.7 on port 7777.
- Unverified on this run: Windows native GPU/HDR playback, physical Chromecast
  (owner already passed that separately), and a GitHub/APK/Docker publish.

2026-08-12, v2.9.6 immediate Continue Watching repaint + reproducible emulator route:

- Version contract aligned: `package.json` 2.9.6; Android `versionName` 2.9.6 /
  `versionCode` 324; all four Windows client version spots 2.9.6.
- Returning from Details/player to Home now synchronously rebuilds Continue
  Watching from the locally-upserted watch cache before the preserved page can
  paint stale progress, then refreshes next-up data in the background while
  restoring the exact focused item and scroll position. A behavioral phase4
  regression executes the extracted return path and proves the fresh resume
  value is published before the background load.
- The Android stress helper now detects a debug emulator whose saved Triboon
  origin is loopback (the QA AVD uses `127.0.0.1:7782`), verifies the host
  Triboon server first, and establishes the required `adb reverse` route.
  `verify:full` forwards the host port; docs cover the override and intentional
  authentication boundary. The dedicated non-admin `qa_stress` account was
  reset with an unlogged random password and its emulator session retained;
  owner credentials were not changed or persisted by the verification work.
- `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidHostServerPort 7777` passed every gate again on the final versioned
  tree after the libmpv lock correction: focused P9,
  P14, and P11 suites; full Node suite 464/464; isolated server smoke; Android
  lint/native unit/debug build; and Android ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260813-072529.json` with `ok: true`,
  zero failures, zero warnings, and the recorded 7782 -> 7777 route.
- A second focused device smoke seeded a 120/600-second watch point and passed
  native VOD start, Continue Watching resume, and seek coverage:
  `bench/stress-results/android-tv-stress-20260812-213549.json` (`ok: true`,
  requested resume 120 seconds, resume fraction 0.2, zero failures/warnings).
- The first `v2.9.6` main CI run caught that the previously checksum-pinned
  upstream LGPL libmpv release asset had been removed. The Windows package lock
  now targets immutable release `2026-08-12-f4d13e1c2c`; its GitHub digest and
  an independent local SHA-256 both matched
  `20dffed429610b52dbb9e3d5b4124145b2a954ef3e6e8fe319cc249a5a794c51`,
  and extracted `libmpv-2.dll` matched
  `34bdbb5c56132fbed513fd13a9401fb729e206309e7b4c091dc3a4b70b423fd4`.
  The locked local Windows recipe then passed all 19 Rust tests, built the
  v2.9.6 NSIS installer, extracted it, and byte-verified the executable, DLL,
  licenses, source/rebuild instructions, notices, and Rust inventory; the
  unsigned local installer SHA-256 was
  `a5c2e0403982f5b926cdca4b531e8a22dc110c98f3b0840d933a92d89fd3c2bd`.
- Docker Desktop 29.5.2 built `triboon:verify-v2.9.6` from the final tree. An
  isolated container with a fresh disposable volume reached `healthy` and
  `/api/server` reported version 2.9.6 / phase 4 before cleanup.
- Unverified on this run: real-provider playback (the local configured QA
  source was used), physical-TV behavior outside the emulator, and Windows
  native playback (unaffected by these web/verification changes).

2026-08-11, v2.9.5 NNTP pipelining becomes a dashboard setting:

- Version contract aligned: `package.json` 2.9.5; Android `versionName` 2.9.5 /
  `versionCode` 323; all four Windows client version spots 2.9.5.
- Streaming performance gains "NNTP pipelining" (nntpPipelineDepth, clamp 0–4,
  default 0 = off). The depth rides provider pool opts and joins the pool key,
  so saving the setting rebuilds pools live — no restart on any platform. The
  `TRIBOON_NNTP_PIPELINE` env stays honored as a fallback when the setting is
  0, so pre-setting deployments keep working. Live round-trip verified in the
  browser: field → save 4 → server stores 4 → reloads into the field.
- Fixed in passing: the retry-only-missing triage's random fill could
  under-sample its probe budget on an unlucky draw (caught by an existing
  phase2 test flaking 3 ≠ 4) — replaced with sample-without-replacement;
  phase2 ran green three consecutive times after the fix.
- `npm.cmd test` passed 462/462 on the final tree (new setting contract).
- `verify:full` fully green on rerun (session-bounce trap, fourth time):
  `bench/stress-results/android-tv-stress-20260811-093658.json` ok: true,
  zero failures — and this stress ran with pipelining depth 4 ACTIVE against
  the QA fixture (the QA settings carry it), doubling as a live soak.
- docs-streaming-performance.md documents the setting in both tables.

2026-08-11, v2.9.4 one-press Continue Watching resume:

- Version contract aligned: `package.json` 2.9.4; Android `versionName` 2.9.4 /
  `versionCode` 322; all four Windows client version spots 2.9.4.
- On TV/native shells, a short press on any Continue Watching cover (movie OR
  episode) now resumes directly — the cover IS the resume, matching the hero
  Resume button, the episode next-up behavior, and the pre-cache warmed on
  focus. Web browsers keep the detail-first stop (1080p/4K pick before play);
  fresh titles still open details everywhere; Details stays on the hold-OK /
  ⋯ card menu. Motivation: the live Shield measurement session showed a 4K
  resume at ~3–4.5s press-to-frame, with the movie detail-page hop as the
  last UX gap vs the browser.
- Verified in a live page by invoking the real card factory with a CW movie
  item under both client modes: browser → openDetail, TV shell → play, fresh
  title → openDetail. phase4 pins the branch; docs-continue-watching.md
  checklist gained item 5b. The Android stress drives resume
  programmatically (asserts resume position), so its contract is unaffected.
- `npm.cmd test` passed 461/461 on the final tree.
- `verify:full` fully green on rerun (the harness-reinstall session-bounce
  trap a third time — harness self-login is now scheduled work):
  `bench/stress-results/android-tv-stress-20260811-084441.json` ok: true,
  zero failures, zero warnings.
- Unverified on this run: Shield real hardware (release APK via CI — owner
  acceptance is one press on a movie CW cover resuming directly).

2026-08-11, v2.9.3 Live TV favorites zap-context fix:

- Version contract aligned: `package.json` 2.9.3; Android `versionName` 2.9.3 /
  `versionCode` 321; all four Windows client version spots 2.9.3.
- Owner-reported bug reproduced in a live browser session against the QA
  fixture (32 channels, 3 favorited across the lineup): the player guide
  auto-landed on the playing channel's home genre even when tuned from
  ★ Favorites, and a guide pick then re-anchored the zap list to that genre.
  Fix: every tune records its origin category (`S.liveTuneCat`, guide- or
  page-selected); the guide reopens on that category with the old genre
  fallback intact; and `ensurePlayerGuideChannels`' cache refresh only fills
  an EMPTY zap list (Android WebView cache-cold no longer clobbers a live
  favorites context). Verified live both ways: favorites tune → guide lands
  ★ Favorites, guide pick keeps the 3-favorite list, zap walks favorites;
  category tune → guide lands the genre, zap walks the full lineup. Zap
  mechanics, shared live upstreams, and adjacent-channel prefetch untouched —
  the prefetch now warms the CORRECT (favorites) neighbors.
- Three phase4 contracts pin the tune-origin recording, guide landing, and
  refresh guard; the older guide-landing contract was updated to the new
  behavior (its "never a stale category" intent preserved via the fallback).
- `npm.cmd test` passed 461/461 on the final tree.
- `verify:full` fully green on rerun (the harness-reinstall session-bounce
  preflight trap again — second occurrence, noted for a harness fix):
  `bench/stress-results/android-tv-stress-20260810-233736.json` ok: true,
  zero failures, zero warnings, including the 20-zap Live TV loop, Multiview,
  and PiP guide checks.
- Unverified on this run: Shield real hardware (release APK via CI — the
  owner's favorites zap repro is the true acceptance check).

2026-08-10, v2.9.2 trickplay + retry-only-missing triage + exact-year scoring:

- Version contract aligned: `package.json` 2.9.2; Android `versionName` 2.9.2 /
  `versionCode` 320; all four Windows client version spots 2.9.2.
- Trickplay scrub previews: new stream-scoped `GET /api/thumb/<mount>?t=&at=`
  route (deny-by-default table entry, auth 'stream' like subtitles) renders a
  480px JPEG near the requested second via ffmpeg reading the mount through
  the local stream route at BACKGROUND priority (lane contract intact), 10s
  buckets, shared in-flight jobs, ~200-entry LRU. Web player shows the still
  above the seek preview (debounced past the nudge cadence, never for Live
  TV, hidden on seek commit). LIVE-PROVEN against a real usenet 4K DV mount:
  200 image/jpeg in 1.5s, frame visually confirmed (HDR tone-map polish noted
  as follow-up). phase4 pins the markup, wiring, live-gate, and token scoping.
- Retry-only-missing triage: probe budget spent by priority — known failures
  first, then never-sampled, then least-recently-proven; budget never shrunk,
  so wide sweeps still find mid-session takedowns (the existing rot test
  passes unchanged). New e2e test proves failure-retry, coverage growth, and
  heal-flips-verdict.
- Exact-year scoring: `wantedYear` +20 breaks same-tier ties toward the true
  year; ±1 stays accepted as fallback. phase2 test pins boost and no-year
  neutrality.
- `npm.cmd test` passed 461/461 on the final tree.
- `verify:full` fully green (exit 0, all 10 steps): first run failed only at
  the stress preflight (the harness's own reinstall bounced the app session —
  documented rig trap, re-login + rerun); rerun passed everything with
  `bench/stress-results/android-tv-stress-20260810-224856.json` ok: true,
  zero failures, zero warnings.
- Unverified on this run: Shield real hardware (release APK via CI), thumbs
  under real multi-user load (single-user dev check only), Windows native GPU
  playback (no client change).

2026-08-10, v2.9.1 native progressive seek + device pre-cache:

- Version contract aligned: `package.json` 2.9.1; Android `versionName` 2.9.1 /
  `versionCode` 319; all four Windows client version spots 2.9.1.
- Native progressive seek: `ProgressiveSeek.java` shares the web curve (x1 x1
  x2 x3 … cap x8, pause/flip resets, reset on playback release); 4 JUnit
  cases green; phase4 pins the nativeSeekBy wiring and the release reset.
- Device pre-cache: `/api/prepare` offers a tokened prefetch for DIRECT-play
  mounts within the new owner-tunable Streaming performance "Device preload"
  setting (devicePreloadMb, default 12, clamp 0–64, 0 = off). Both prepare
  paths (detail/CW focus + near-end Up Next) hand the offer to the shell;
  the shell re-validates trusted origin AND `/api/stream/` path, caches into
  a 100MB on-device LRU keyed WITHOUT the rotating token
  (`StreamPrecache.java`), and direct-play reads through a READ-ONLY cache
  wrap (remux/transcode/live never wrapped; non-direct keys keep the full
  URL so a mis-wrap can never collide start positions). Emulator-proven
  end-to-end: `Precache complete: 12582912B` in logcat after a detail open,
  then a clean native play through the wrapped source (position advancing,
  no native errors). Development caught and fixed: decidePlayback returns
  `{method}` not `{kind}` (contract-pinned), and a NaN in the settings clamp.
- `npm.cmd test` passed 459/459 on the final tree.
- `TRIBOON_ADB_DEVICE=emulator-5554 TRIBOON_STRESS_VOD_KEY=tmdb:movie:120
  npm.cmd run verify:full` fully green (exit 0) over these changes: P9 IPTV,
  P14 fast VOD, P11 subtitles, full Node suite, isolated `/api/server`,
  Android lint/unit/debug build, ExoPlayer stress
  `bench/stress-results/android-tv-stress-20260810-214956.json` ok: true,
  zero failures, zero warnings. The gate ran immediately before the version
  bumps; version strings do not affect server or player behavior.
- Unverified on this run: Shield real hardware (release APK arrives via CI;
  perceived press-play speedup from the pre-cache is measured there), real
  provider VOD (QA fixture), Windows native GPU playback (no client change).

2026-08-10, v2.9.0 progressive seek + NNTP pipelining prototype (default OFF):

- Version contract aligned: `package.json` 2.9.0; Android `versionName` 2.9.0 /
  `versionCode` 318; all four Windows client version spots 2.9.0.
- Progressive D-pad seek: rapid same-direction presses accelerate x1 x1 x2 x3 …
  capped x8, pause/direction-flip resets. Verified live in the browser page
  (burst 30/60/120/210/330; flip 120→110) and pinned by a phase4 contract.
- NNTP pipelining prototype ships DEFAULT OFF (`TRIBOON_NNTP_PIPELINE=2..4`
  opt-in): low-lane stacking only, stands down while any above-low work is
  queued (the priority-inversion case is a regression test — it caught a real
  inversion during development), per-waiter stall timers re-arm on socket
  progress, explicit picks and default behavior byte-identical (test-proven
  OFF path). Four new e2e tests; mock NNTP now serializes responses per socket
  like a real server. Real-provider bench (`bench/nntp-pipelining-bench.js`)
  is the prerequisite before anyone flips the flag.
- `npm.cmd test` passed 458/458 on the final tree.
- `TRIBOON_ADB_DEVICE=emulator-5554 TRIBOON_STRESS_VOD_KEY=tmdb:movie:120
  npm.cmd run verify:full` fully green (exit 0): P9 IPTV, P14 fast VOD, P11
  subtitles focused gates, full Node suite, isolated `/api/server` smoke,
  Android lint/unit/debug build (vc 318, Media3 1.11.0), and the ExoPlayer
  stress smoke `bench/stress-results/android-tv-stress-20260810-205332.json`
  `ok: true`, zero failures, zero warnings.
- Unverified on this run: real-provider VOD (QA fixture only), Shield real
  hardware (release APK arrives via CI), Windows native GPU playback (no
  client code change). Pipelining is unexercised against a real provider by
  design — it is OFF until the owner benches it.

2026-08-10, v2.8.12 pinned-resume race fix + Media3 1.11.0 verification:

- Version contract aligned: `package.json` 2.8.12; Android `versionName` 2.8.12
  / `versionCode` 317; Windows client `package.json`/`tauri.conf.json`/
  `Cargo.toml`/`Cargo.lock` 2.8.12 (the first gate run caught the Windows
  client left at 2.8.11 — fixed, both release-contract suites re-run green).
- Pinned-resume fix verified at every layer: new `_playableCandidates`
  ordering test (healthy pin leads, rotted pin skipped, manual pick keeps its
  override), race-width source contract (`PLAY_RACE_WIDTH` kept for pinned
  resumes, width 1 explicit-picks-only), and the phase4 client contract
  (`pinnedResume` flagged on replayed pins only). Live-page check on the boot
  UI confirmed pinned resume sends `pickKey + pinnedResume:true`, fresh play
  sends neither, manual pick sends `pickKey` alone.
- `npm.cmd test` passed 454/454 on the final tree (99.4s).
- `TRIBOON_ADB_DEVICE=emulator-5554 TRIBOON_STRESS_VOD_KEY=tmdb:movie:120
  npm.cmd run verify:full` ran the full gate on the QA emulator rig
  (credential-free fixture 60993/53159 + isolated QA server on 7788, fresh
  data dir): PASS Android ExoPlayer stress smoke with Media3 1.11.0.
  `bench/stress-results/android-tv-stress-20260810-194020.json` finished
  `ok: true`, zero failures, zero warnings across boot, page churn, source
  quality separation, Live TV start, native handoff, Multiview, 20-zap loop,
  PiP, VOD start, Continue Watching, seek loop, subtitles, and log scan.
  The only failing gate step was the version mismatch above; the Node suite
  was re-run 454/454 after the fix while stress evidence remained valid (the
  Windows version strings do not affect server or Android behavior).
- Media3 1.10.1 → 1.11.0: `gradle assembleDebug testDebugUnitTest` green;
  the stress smoke above is the on-device proof. Shield-hardware re-check
  rides the normal post-release APK update on real hardware.
- Unverified on this run: real-provider VOD (QA fixture only), Windows native
  GPU playback (no client rebuild in this change set — icons and version
  strings only), and Shield real-hardware playback (release APK arrives via
  CI after the tag).

2026-07-15, v2.7.1 public documentation, privacy, and delivery verification:

- Audited every tracked public Markdown document and the live Settings copy.
  Relative links resolve in a clean clone; the retired Trakt application URL
  was replaced by the current official guide, and Wyzie key/quota instructions
  now match the current service. Desktop and 390x844 mobile browser checks
  rendered the updated Trakt panel without clipping or horizontal overflow.
- `node --test test/release-contract.test.js` passed 9/9 and the final
  `npm.cmd run verify:full -- -AndroidDevice emulator-5554` passed in 389.7
  seconds on the staged tree. The gate repeated P9 Live TV, P11 subtitles, P14
  fast VOD, all 431 Node tests, isolated `/api/server`, Android lint/unit/build,
  APK reinstall, and Android ExoPlayer stress.
- `bench/stress-results/android-tv-stress-20260715-122207.json` finished
  `ok: true` with no failures or warnings: page/D-pad churn passed, 1080p and
  2160p source selection stayed separated, 32 synthetic Live TV channels
  loaded, native handoff/Multiview passed, VOD started and survived the seek
  loop, and subtitle lookup returned HTTP 200.
- A clean Docker build sent only 1.42 MB of allowlisted application files to
  the builder. The image-boundary check found no repository `data/`, `.env`,
  `.git`, Android material, Docker credentials, or sensitive-looking image
  environment values. A fresh disposable container reached `healthy` and
  `/api/server` reported 2.7.1 with setup still unclaimed.
- The release workflow now verifies anonymous `latest` and immutable semver
  manifests, both required architectures, source-revision labels, fresh-data
  health, and `/api/server` before a tagged release can become public. GitHub
  private vulnerability reporting, secret scanning, push protection, and
  Dependabot security updates are enabled; the live audit found no open secret
  or Dependabot alerts, and the staged secret-pattern scan found no matches.
- Emulator work used an isolated temporary copy of configured server state plus
  a synthetic local IPTV fixture. It was never committed, copied into the
  container, or published, and both the fixture and temporary data directory
  were removed immediately after verification.

2026-07-15, v2.7.1 buffering / 4K resume / final-checkpoint verification:

- Version contract aligned: `package.json` 2.7.1; Android `versionName` 2.7.1
  / `versionCode` 304.
- The focused Phase 4 suite passed 64/64 and `npm.cmd test` passed 429/429.
  Final checkpoints cover browser/native pause, Back/Stop, EOF/Up Next, Cast,
  Multiview, page hide, mobile visibility loss, and Android backgrounding;
  duplicate lifecycle beacons at the same position are coalesced.
- `npm.cmd run verify:full -- -AndroidDevice emulator-5554
  -AndroidVodKey tmdb:movie:1226863 -AndroidVodQualityRank 4
  -AndroidVodResumeSeconds 120 -AndroidVodDurationSeconds 7200` passed on the
  final tree in 414.5 seconds. It repeated P9 IPTV, P11 subtitles, P14 fast VOD,
  inline web parsing, isolated runtime smoke, Android lint/unit/build/install,
  and Android TV stress.
- Android TV API 36 stress report
  `bench/stress-results/android-tv-stress-20260715-100924.json` finished
  `ok: true` with no failures or warnings. It found 59 4K-class sources and
  mounted a 2160p release, resumed a requested 120-second point at 135 seconds,
  then progressed through seek samples at 175, 215, and 235 seconds. The
  emulator's HEVC decoder rejected the 4K format, and Triboon recovered through
  its supported remux/transcode ladder instead of freezing. Subtitle lookup
  returned HTTP 200, and page/D-pad churn, native IPTV, Multiview, and PiP all
  passed with no fatal log finding.
- A real Android media-stop immediately after that run persisted position 279
  / duration 7200 to the selected profile's `/api/watch` row before the server
  was queried, proving the latest Continue Watching checkpoint survives Stop.
- The device run used an isolated temporary copy of configured server state. It
  never entered git, a container layer, or a release asset, and the directory
  was removed after verification.

2026-07-14, v2.7.0 episode-handoff release verification:

- Version contract aligned: `package.json` 2.7.0; Android `versionName` 2.7.0
  / `versionCode` 303.
- Manual Play Next, EOF autoplay, and episode-strip selection now enter the
  replacement player before any local lookup/search/mount await. Web media
  events, Android ExoPlayer listeners/actions, source recovery, and asynchronous
  subtitle preflight work are bound to the playback identity/token, so delayed
  work from episode A cannot close, remount, reconfigure, or subtitle episode B.
- The focused Phase 4 player suite passed 61/61, including executable races for
  Play Next followed by episode A's queued `ended`, late keyframe/remount/source
  advance, native quality selection, and delayed built-in subtitle preflight.
  A separate `npm.cmd test` pass and the final full gate each passed 419/419.
- `npm.cmd run verify:full -- -AndroidDevice emulator-5554` passed on the final
  tree in 313.5 seconds. It repeated P9 IPTV, P11 subtitles, P14 fast VOD,
  inline web parsing, the isolated 2.7.0 runtime smoke, Android `lintDebug`,
  `testDebugUnitTest`, `assembleDebug`, APK install, and Android TV stress.
- Android TV API 36 stress report
  `bench/stress-results/android-tv-stress-20260714-102951.json` finished
  `ok: true` with no failures or warnings: 32 deterministic fixture channels,
  source ranking, native Live TV, 20 zaps, two PiP loops, native Multiview,
  native VOD with 10 seek actions, subtitles, and repeated page/D-pad churn.
  The matching focused device pass
  `bench/stress-results/android-tv-stress-20260714-102431.json` also completed
  with zero failures or warnings before the full gate repeated it. The stress
  helper now recognizes current `.pcard` Home tiles as well as legacy card
  classes, so a valid catalog-only Home cannot be misreported as empty.
- On the authenticated deterministic UI fixture, desktop Chrome changed
  S01E01 to S01E02's in-player `Preparing` state in about 538 ms with no show
  detail flash, then resumed S01E02 playback. The Android TV emulator likewise
  exercised direct E01 -> E02 handoff plus Back/cancel and autoplay behavior;
  the final APK/stress pass was repeated after the last stale-callback guard.
- The environment used synthetic media and mock NNTP. No real provider title
  was downloaded during this pass, so provider-specific availability and WAN
  timing remain outside this local verification.

2026-07-13, v2.6.20 pre-release verification:

- Version contract aligned: `package.json` 2.6.20; Android `versionName`
  2.6.20 / `versionCode` 302; the isolated runtime smoke returned 2.6.20
  from `/api/server`.
- `npm.cmd test` passed 415/415. The late artwork/navigation regression slice
  passed 9/9, the corrected IPTV cache fixture passed its focused and related
  reruns, and both inline web scripts parsed.
- `npm.cmd run verify:full -- -AndroidDevice emulator-5554` passed again on the
  final candidate in 296 seconds. This repeated the P9/P11/P14 gates, all 415
  Node tests, isolated
  runtime smoke, Android `lintDebug`, `testDebugUnitTest`, `assembleDebug`, APK
  install, and Android TV stress.
- Android TV API 36 stress report
  `bench/stress-results/android-tv-stress-20260713-173627.json` finished
  `ok: true` with no failures or warnings: 32 deterministic fixture channels,
  correct 1080p/2160p source ranking, native Live TV, 20 zaps, two PiP loops,
  native Multiview handoff, native VOD with 10 seek actions, subtitles, and
  repeated page/D-pad churn. Raw emulator logs still contain Android platform
  AppOps/media-button noise and are not described as silent.
- Desktop Chrome at 1424x805 and mobile web at 390x844 loaded Home, Movies,
  TV, Discover, Search, Music, Audiobooks, and Preferences against the local
  deterministic UI fixture. Watchlist, Calendar, and Live TV rendered their
  expected empty states. A TV detail rendered all three episodes with 16:9
  artwork, including the layered show-art fallback for a missing still. There
  were no uncaught runtime errors or mobile horizontal overflow.
- Android TV and phone API 36 both ran the 2.6.20/code 302 APK. The same TV
  detail rendered all three episode covers; D-pad Left moved between episode
  cards and the corrected Back ordering was exercised. The TV Library modal
  opened its native dropdown from OK and changed Type to TV Shows. The
  1080x2400 phone WebView completed the full page sweep with the episode
  artwork visible, no horizontal overflow, and no detected page-script error.
- The stress environment used synthetic MPEG-TS and deterministic source
  fixtures. A real usenet-provider VOD download was not started, so no claim
  is made about provider-specific availability in this pass. The streaming
  engine itself was not changed; its startup, buffering, source selection,
  native handoff, IPTV, and subtitle contracts were rerun through P9/P11/P14
  and the emulator stress gate.

2026-07-13, v2.6.19 pre-release verification:

- Version contract aligned: `package.json` 2.6.19; Android `versionName`
  2.6.19 / `versionCode` 301; isolated `/api/server` returned 2.6.19.
- `npm.cmd test` passed 401/401. The complete security suite passed 111/111
  and the release contract passed 6/6.
- The final `npm.cmd run verify:full -- -AndroidDevice emulator-5554` passed
  in 298.5 seconds, including P9/P11/P14, web script parsing, another complete
  401-test run, isolated runtime smoke, Android `lintDebug`,
  `testDebugUnitTest`, `assembleDebug`, APK install, and Android TV stress.
- Android TV API 36 stress report
  `bench/stress-results/android-tv-stress-20260713-144522.json` finished
  `ok: true` with zero helper failures/warnings: 32 fixture channels, native
  Live TV, 20 zaps, two PiP loops, native Multiview handoff, native VOD start
  with 10 seek actions, and subtitle HTTP 200. The scanner found no app fatal
  or provider-protection loop. Raw emulator logs still contain platform
  AppOps/media-button warnings and are not described as silent. One earlier
  attempt lost its WebView target after a transient PiP precondition miss
  backed the app to the launcher; logs showed no crash, and both the clean
  standalone rerun and this final full gate passed.
- Android phone API 36: installed the 2.6.19 APK and visually checked portrait
  Home, off-canvas menu, and Preferences at 1080x2400 (412x839 CSS viewport).
  Physical touch opened the menu/settings, there was no horizontal overflow,
  system Back returned Preferences to Home, and hardware/predictive Back now
  dismisses the mobile drawer before navigation or exit. A real fixture movie
  opened in native ExoPlayer, rotated to 2400x1080 landscape, rendered frames
  and fitted touch controls, and a direct seek-bar tap advanced the display
  position from 2841s to 4674s. First Back hid native controls while playback
  and landscape remained active; second Back closed playback, restored portrait
  Home, and kept the page within the viewport. The focused log gate found no
  Triboon fatal, ANR, Chromium error, or Exo playback error. Phone CC was not
  repeated live; the TV stress subtitle pass and mobile caption/overflow
  contracts in `test/phase4.test.js` cover that remaining surface.
- Docker gate passed with an isolated v2.6.19 image and healthy loopback-only
  container. `/api/server` returned HTTP 200/version 2.6.19 and detected
  ffmpeg, subtitle sync, Music, and Music catalog; all test containers,
  networks, volumes, and images were removed without touching other services.
- Windows package gate passed 16/16. The locked build produced
  `Triboon-Setup-v2.6.19.exe` (101,886,506 bytes; SHA-256
  `CFB7FE997AEF66D3A0F15FB0F6CE23BFB64DE5E26B5F0255152E23226C134C17`).
  Its isolated staged server returned version 2.6.19 with ffmpeg/subtitle sync
  detected and no stderr. The elevated service/firewall/install-upgrade-
  uninstall cycle was not run because it would alter the host; the installer
  remains unsigned as documented.

#### Historical evidence (superseded release mechanics)

The dated entries below are retained for audit history only. Their APK names,
signing defaults, test counts, and publishing workflow do not define the
current release; `docs-app-updates.md` governs current publishing.

2026-06-27, distribution signing (v1.7.43):

- Switched APK signing from the per-machine Android DEBUG key to a dedicated RELEASE keystore the
  owner controls + backs up (debug-signed builds were verified identical to the v1.7.30 asset, i.e.
  every prior release was debug-signed — machine-tied + unrecoverable if lost, unsafe for a
  distributed app). The keystore + passwords live OUTSIDE git; keep an encrypted backup — losing
  them strands all future updates.
- v1.7.43 published release-signed (CN=Triboon) as the Latest GitHub release with the four assets
  (triboon-tv-vX.Y.Z / triboon-mobile-vX.Y.Z + stable triboon-tv / triboon-mobile aliases);
  /releases/latest/download/triboon-tv.apk resolves to it (HTTP 200, release-signed verified).
- ONE-TIME: switching keys changes the signature, so devices on an older debug-signed build must
  uninstall + reinstall once; future updates install in place.
- Release build verified: R8/minify + the new key produce a working APK (launches to the native
  setup screen, ExoPlayerImpl + HlsMediaSource present in the dex, no crashes).
- Automation: npm run release:apk (defaults to debug signing; -Release for the keystore build) and
  a CI release-apk job (TRIBOON_RELEASE_* repo secrets) that auto-builds + publishes the signed APK
  on every vX.Y.Z tag (and via workflow_dispatch). CI signing pipeline verified end-to-end against
  v1.7.43.


2026-06-27, startup + pause/resume + nav + guide (v1.7.41/v1.7.42):

- Startup win #1 (v1.7.41): first-article STAT probe runs CONCURRENTLY with the mount instead of
  gating it. Measured via bench/startup-latency.js on the mock provider — play()→mounted dropped
  203→142ms @60ms RTT and 626→418ms @200ms RTT (~one RTT off every cold play). Dead-source skip +
  slow-probe semantics preserved; phase2 timing assertion moved after the now-async probe settle.
- Pause/resume stall fixed: abortRead no longer cancels the shared read-ahead epoch for
  read-ahead/warm-ahead/background lanes (a closing warm-ahead connection was stranding the live
  player's prefetch on resume — "stuck unless I rewind"). Source assertion added.
- Universal two-step Back (verified on emulator): movies grid idx6 → Back → idx0 → Back → rail;
  music deep idx5 → Back → idx0 → Back → rail.
- Music results D-pad is true 2D (verified): from a song, Right → next column, Down → next row
  (was: Down acted like Right through the 2-col grid).
- Continue Watching removal sticks: profile-scoped local hidden set (cwHideNext/cwHiddenNextSet)
  survives the post-remove loadWatchState reload (server strips hidden from /api/watch) + restarts.
- Native live favorite star now D-pad reachable (added to nativeControlButtons); web-guide-PiP path
  no longer falls to the web player with VOD controls (takes over natively).
- Crash resilience: android:largeHeap=true; multiview MSE buffer retention scales DOWN with pane
  count (4 panes ~15s each, trim sooner) to cut renderer OOM ("Web Page crashed").
- PiP guide (v1.7.42): both the PiP guide and main Live TV guide already default to the timeline
  view with logos (S.liveGuide defaults true when EPG exists; both use ch.logo). Fixed the PiP
  guide's scroll JUMP — it was the only place using scrollIntoView block:'center' on focus restore
  (recentering on every category switch / channel play); now 'nearest', matching the main guide.
  Verified on emulator: PiP guide shows channel logos + EPG timeline + Now/Next; category switch
  (United States→Kids) keeps the guide stable.
- npm test 249/249 (--test-force-exit avoids the node:test post-run fake-hang); Android
  assembleDebug OK; inline web JS parses.


2026-06-27, guide/multiview polish (v1.7.40) — owner-reported nav bugs + multiview picker redesign:

- Multiview picker redesign: dropped the repeated group label ("United States" on every row — the
  unprofessional noise) in favor of channel logo + name with a clear selection highlight. Verified
  on emulator (clean rows, amber selection). Logos load from the same URLs the main guide uses
  (img-src allows external); they don't render on the emulator's sandboxed network but collapse
  cleanly to name-only when a logo is missing/fails.
- Bug: multiview channel picker D-pad stuck + Back→home. Root cause: key dispatch + __tvBack gated
  on S.view==='multiview', which drifts while the picker is open. Now gated on S.multiView.open.
  Verified: picker D-pad moves focus (rows[0]→rows[1]); hardware Back closes the picker
  (view=multiview, mvOpen stays true), not home.
- Bug: Back from deep in the Live TV guide jumped to home. Now Back from a channel/non-first
  category returns to the FIRST category (Favorites) first. Verified: from category idx 2, Back →
  catIdx 0, still in livetv (not home).
- Bug: returning from a played channel reset the guide to the top / changed category. Now
  rememberPlayerReturn saves liveCat + category index + channel focus + scroll, and the Live TV
  scaffold restores them instead of focusGrid(0). (Code + phase4 assertions; round-trip feel to be
  confirmed on a real device.)
- Bug: favoriting from the Favorites view jumped the screen. The full rebuild now preserves focus
  (renderLiveFavListKeepingFocus re-focuses the clamped index) instead of snapping to the top.
- npm test 249/249; inline web JS parses; new behavior covered by phase4 assertions (multiview Back
  guard regex updated to track the stronger S.multiView.open gating — not weakened).
- NOTE: startup-speed pass done as ANALYSIS (see chat) — 2 concrete wins identified (overlap the
  pre-mount STAT probe; start warmup before the health gate). NOT implemented this pass: they touch
  the hot playback path / P14 contract and want real wall-clock measurement (verify:live on a
  usenet-configured box) before changing.

2026-06-27, audit follow-through (v1.7.39) — recommended-next fixes + owner-approved settings:

- Music: stream URL cache now scoped by cookie identity (no cross-user variant bleed); next-track
  prefetch warms the following track's resolve for gapless sequential play; bounded auto-skip loop
  (prior entry). MediaSession action handlers were already present (audit false positive, verified).
- CC: native auto-sync no longer double-applies a manual subtitle offset (strips shift from the base
  URL and passes subtitleShift:0, since alass already corrects to the video).
- Playback: DTS-core MKV on a device that can't decode DTS now remuxes instead of playing silent
  (decidePlayback gate extended; only triggers on explicit caps.dts===false, never over-remuxing).
  New phase4 test.
- Settings (owner-approved): per-user allowTranscode is now ENFORCED at /api/transcode (403) with an
  admin toggle in the user list; streaming-performance Profile presets (Fast/Balanced/Large) now
  fill the buffer/connection fields (verified: Fast → buf1080=45, conn1080=8, reserve=40);
  opensubtitles.com username/password inputs added to the Subtitles panel (server already stored
  them encrypted; password never round-trips, blank never wipes).
- npm test 249/249; Android assembleDebug → APK; inline web JS parses. New web pieces verified live
  on emulator (prefetchNextMusicStream, PERF_PRESETS, osUser/osPass inputs, __tvLiveFavToggle).

2026-06-27, full audit pass (6 subsystems) — high-confidence fixes, verified on emulator:

- Screensaver (owner: never during playback): canShowScreensaver now also gates on S.playing +
  body.videoOpen, covering native ExoPlayer (WebView visible behind the surface) and paused-active
  playback — no longer resting on the single S.view string. Verified live (guard references S.playing).
- IPTV player controls (owner: show favorite, hide sound/HD): the Android NATIVE live chrome now
  hides CC/audio/quality/next/rew/fwd and shows a FAVORITE star (new ic_player_fav/_on). Web layer
  owns the favorites store; native tap → __tvLiveFavToggle → toggleLiveFavorite → POST → setLiveFav
  pushes the star state back. Verified on emulator: played ABC live, chrome showed play + star +
  info only; toggling filled the star and flipped the channel's fav=true in the store, then back.
  Web player also hardened (srndBtn hidden for live in JS, not just CSS !important).
- Guide lag (owner: smooth category D-pad): category switching debounces the ≤400-card channel-pane
  rebuild (was a full rebuild per keystroke). S.liveCat applies immediately (RIGHT/Enter stay
  correct); render defers ~150ms or flushes on entering channels. Verified: rapid focusLiveCategory
  keeps state immediate, render pending coalesced, flush renders once.
- 4K toggle with no 4K source now falls back to the best available (was: play fails outright).
  New pipeline test added.
- Music: bounded the auto-skip loop (shuffle/repeat-all on a wholly-unplayable queue looped forever
  spawning yt-dlp); now stops after one full lap, resets on a real play.
- CC: osLang no longer truncates an unmapped 3-letter code to a bogus 2 letters (ces→cs verified,
  not ce); srp_latn added for server parity.
- npm test 248/248 (added 4K-fallback + IPTV-favorite + screensaver-guard assertions; updated
  screensaver/live-category/quality regexes to track the improvements, none weakened). Android
  assembleDebug → APK. Inline web JS parses (0 errors).
- Audited and found CORRECT (no change): quality cap-at-source (1080p user never gets 4K), audio
  AAC-safe path on browsers, passthrough when device can decode, IPTV slot eviction (no leak),
  favorites source-scoped delete cleanup, Back layering, LEFT-always-reaches-menu, streaming-perf
  numerics flow into the pipeline, secrets encrypted/redacted, music process hygiene (no leaks).

2026-06-27, TV "next episode" — prefetch + Up Next parity (web + ExoPlayer):

- Review finding: next-episode prefetch only warmed `/api/search` on START (the pipeline's search
  cache lives ~60s, so it was stale long before a 40-min episode ended), and the web `#upNext`
  card couldn't render on Android because the WebView is hidden behind the ExoPlayer surface
  (`web.setVisibility(View.GONE)`) — so on exo the popup only appeared AFTER the episode ended.
- Fix A: new `maybePrepareNextEpisode(t,d)` fires `/api/prepare` ~90s before the end (from both the
  web tick and the 1Hz native progress callback), leaving a live mount that `play()` reuses
  instantly; one-shot, reset on teardown, skipped for local-library episodes.
- Fix B: native ExoPlayer Up Next card (`TriboonTV.upNext`/`upNextHide`, `nativeChromeVersion`→2).
  Countdown stays in the web layer (single source of truth, runs while the WebView is hidden) and
  drives the native card; Play/Dismiss forward back to web; Back dismisses the card first.
- Verified on emulator (Triboon_TV_API_36, app reaching dev server via `adb reverse`):
  - App launches, MainActivity resumed, no crash; `nativeChromeVersion()`=2; `TriboonTV.upNext`/
    `upNextHide` present; web `nativeUpNextBridge`/`maybePrepareNextEpisode`/`hideUpNextUi`/
    `__upNextPlayNative` all defined.
  - Played a local-library movie natively (ExoPlayer, dur 4756s) → `buildNativePlayerLayer` built
    the card with no crash. Forced `TriboonTV.upNext(...)` → card rendered OVER the video ("UP NEXT"
    kicker, title, S01E02, **Play Next · 8** focused + Dismiss). `upNextHide()` cleared it cleanly.
    Hardware BACK dismissed the card and notified web (`upNextShown:false`) WITHOUT closing playback
    (`view:player`, `usingNative:true`). Screenshots captured.
- `npm.cmd test` 247/247 (updated one phase4 regex to track the countdown refactor — same 10s-window
  + `playNextEpisode()`-at-0 guarantee, not weakened). Android `assembleDebug` → 5.3 MB APK. Inline
  web JS parses with 0 errors.
- Not verifiable on the dev box (no usenet creds): the near-end `/api/prepare` actually mounting a
  TMDB episode for instant handoff. Wiring is in place and the call fires; the mount/instant-resume
  needs a usenet-configured box (owner) or `verify:live`.

2026-06-27, bulletproofing — closed two of the documented-open test gaps + shipped a live self-test:

- New `test/phase2.test.js` coverage (247/247 pass):
  - `pipeline: multi-user concurrent VOD streams stay byte-exact and never exceed the connection
    cap` — 4 simultaneous streams (full read + cold seek each) share one 12-connection NntpPool
    with simulated RTT; asserts every byte exact under contention AND the pool never opens more
    than its cap (no connection leak under load). This was a CLAUDE.md "still open" item.
  - `pipeline: resume re-checks health and auto-advances when the saved source died while away` —
    a source that streamed fine has every article taken down on the provider; the resume health
    re-check (`vf.triage`, what `/api/health` runs) now returns `blocked` live, and `advance`
    hands off to a healthy source byte-exact, including a resume-point cold seek.
- New `bench/verify-live.js` (`npm run verify:live`): zero-dep guided self-test that measures the
  real provider path (ready / first-byte / seek / resume / method / health) on a configured box.
  Smoke-tested on the dev server (no creds): logs in, reads `/api/server`, drives `/api/play`,
  and honestly reports `no indexers configured` with exit 1 — proving the wire path. Real timing
  numbers must be captured on the owner's configured server/unraid box.
- Still unverified here (no creds on dev box): actual press→frame wall-clock, audio on real usenet
  content, and resume on a genuinely dead real NZB. `verify:live` is the tool to capture these.



2026-06-26, v1.7.35 Multiview VOD audio — complete fix + on-emulator verification:

- Root cause confirmed on the emulator: clientCaps reported ac3:false, eac3:false, dts:false,
  aac:true — the WebView only decodes AAC. v1.7.34's forceAacRemux only applied on the remux path,
  but multiview VOD often played 'direct' (server pick), so AC3/EAC3/DTS sources were silent.
- Fix: multiViewVodUrl + multiViewVodUrlFromSlot now PREFER remux+audioSafe (AAC) over direct
  whenever a remux endpoint exists (transcode still used when the server requires it).
- Verified on emulator-5554 against a working provider (HiveCast Xtream) + a local library:
  - multiViewVodUrl now returns kind:'remux' with audioSafe=1 even when the server picks 'direct'.
  - Played a local movie companion in a pane: kind='remux', status 'Playing', currentTime
    advancing, muted=false when active, src = remux URL with audioSafe=1. End-to-end audio path
    confirmed.
  - Bug 1 (eviction) re-confirmed: 3 concurrent panes (ESPN/AMC/TNT) all played, none evicted;
    audio followed the active pane. Bug 3 (black screen) re-confirmed: clean close to Live TV.
- `npm.cmd test` 245/245.

2026-06-26, v1.7.34 Multiview fixes (3 user-reported bugs):

- Adding a 2nd channel killed the 1st ("network error"): the live slot key was hash(uid|ip|ua),
  identical for every pane, so each new pane evicted the previous via prev.close('retuned'). Fixed
  with a per-surface id (main/split/mv0..3) the client appends and the server folds into the slot
  key. New iptv-cache integration test proves two panes stream concurrently and retuning one pane
  doesn't drop the other.
- Movie/TV panes had no sound: the VOD URL builders hardcoded forceAacRemux:false, so the remux URL
  omitted audioSafe=1 and AC3/EAC3/DTS audio was copied (browser can't decode). Now force AAC remux
  for multiview VOD.
- Black screen after leaving multiview: closeMultiView removed videoOpen but left the underlying
  #player/#video surface .open behind the multiview; on exit that paused/black video was revealed.
  closeMultiView now tears down the player surface (pause/clear #video, drop #player .open, clear
  nativeGuideMode) before switching views.
- `npm.cmd test` 245/245 on Windows. NOT exercised live on a device here (no real IPTV streams in
  this env); root causes are deterministic and covered by the new tests — confirm on the device
  after deploy.

2026-06-26, v1.7.33 Automatic subtitle sync (alass) + OpenSubtitles validated:

- Decision: keep Wyzie (unlimited, free) as the subtitle source and auto-correct sync with alass;
  skip OpenSubtitles as a default (daily download cap not worth it for a no-pay user). OpenSubtitles
  search/normalize/ranking were validated against the LIVE API with the owner's key (movie + episode
  + `ger`->`de` language normalization all returned correct results) and remain available, gated.
- alass engine: `apk add gcompat` + the v2.0.0 static binary. **Docker build-verified**: built the
  real image, `alass --help` runs and `detectSubSync()` returns `{path:'alass'}` inside the
  container, so `subSync` will be true once deployed. Auto-sync is gated — absent alass, the CC path
  is unchanged.
- Skip-when-synced: `subtitleLooksSynced` (moviehash/provider-release/release-key match) means alass
  (which reads audio) only runs for non-matched subs; failures fall back to the unsynced track, so
  auto-sync can never regress playback.
- `npm.cmd test` 244/244 on Windows (added alass gating + subtitleLooksSynced + OpenSubtitles mock
  + language tests). Android `gradlew assembleDebug` BUILD SUCCESSFUL at 1.7.33 / code 97.
- NOT verified here (no device + no alass at runtime + no usenet creds): the alass alignment QUALITY
  on a real NZB stream, and the native ExoPlayer hot-swap end-to-end. Both are background + fallback,
  so worst case is the unsynced sub (today's behavior). Recommend an on-device pass after deploy.

2026-06-26, v1.7.32 Captions (language + hash-exact) and warm resume:

- `npm.cmd test` 242/242 on Windows. New coverage: Wyzie key redaction in the
  `[subs]` diagnostic log, ISO 639-2 B/T -> 639-1 normalization, OpenSubtitles
  search->login->download->VTT (mock server), and the resume focus-prefetch wiring.
- Android `gradlew assembleDebug` BUILD SUCCESSFUL at versionName 1.7.32 /
  versionCode 96 (this release's code changes are web/server only — the WebView
  shell loads the web UI from the server, so the language fix ships without an APK
  rebuild; the bump keeps versions in lockstep per the release rule).
- CC fixes verified by unit/mock tests; NOT exercised end-to-end on a live
  provider here (this box has no Wyzie/usenet/OpenSubtitles creds — deliberately
  not persisted). Verify on the real server: reproduce a caption and watch the
  `[subs]` log line show `lang=ces->cs` etc.; OpenSubtitles is gated OFF until
  `TRIBOON_OS_API_KEY/USER/PASS` are set, so the Wyzie path is unchanged by default.
- Risk: OpenSubtitles response shape coded to the published REST contract but not
  hit against the live API here; it is fully gated, so an unconfigured server is
  byte-for-byte the prior Wyzie behavior (the existing Wyzie integration test
  still passes).

2026-06-26, v1.7.31 Multiview picker D-pad fix:

- Root cause: the Multiview channel/Continue-Watching picker drove all D-pad
  navigation off `document.activeElement`, but the Android TV shell forwards
  synthetic DOM key events while real DOM focus stays on `<body>` and the app's
  `applyFocus` only toggles a `.focus` class. So in the picker (which auto-opens
  for screen 2 on launch), Up/Down were stuck on the first two channels, Left
  could not reach categories, OK did nothing, and only Back escaped — matching
  the reported symptom from both the Live TV and PiP-guide entry paths.
- Fix: picker focus is now index-based (`S.mvPickGroup` + `S.mvPickIdx` via
  `setMultiViewPickerFocus`), mirroring the already-working pane/action/top
  branches. Navigation and OK no longer read `document.activeElement`.
- `npm.cmd test` passed 239/239 on Windows, including new phase4 regression
  assertions that the picker is index-based and never reads
  `document.activeElement`.
- Android debug build: `gradlew -p android assembleDebug` BUILD SUCCESSFUL at
  versionName 1.7.31 / versionCode 95.
- On-device proof (emulator-5554, Triboon_TV_API_36, debug APK installed; app
  WebView loading the rebuilt v1.7.31 web UI from the dev server with IPTV
  configured): drove the Multiview picker through the page's REAL global
  keydown handler via synthetic `KeyboardEvent`s (the exact path the Java shell
  uses), with focus held as the shell delivers it. Result:
  `start:rows#0(Ch1) -> dn rows#1 -> dn rows#2 -> dn rows#3(Ch4) -> clamp ->
  left cats#0(Sports, selected) -> catDn cats#1(News) -> Enter fired cat:News
  -> right rows#0 -> dn+Enter fired play:Ch2`. Up/Down walk all channels with
  clamping, Left reaches categories, OK selects both a category and a channel —
  every reported dead-D-pad symptom is resolved on the actual device WebView.
- NOT run here (no release signing secrets): signed APK build + `gh release`.
  The full `android-tv-stress.ps1` live-zap/PiP/VOD-seek smoke was not re-run
  (it covers the unchanged native side; this change is web-only). Recommend a
  quick on-Shield picker walk after the signed APK is installed.

2026-06-26, v1.7.30 Android TV Multiview native-surface fix:

- `npm.cmd run verify:full` passed with `TRIBOON_ADB_DEVICE=emulator-5554`
  after installing the rebuilt APK over v1.7.29. Android reported
  `versionName=1.7.30`, `versionCode=94`.
- Android TV stress output:
  `bench/stress-results/android-tv-stress-20260626-155422.json`.
- Android Multiview proof on `emulator-5554`: `multiNativeHandoff.ok`,
  `multiNativeHandoff.wasNative`, and `multiNativeHandoff.surfaceReady` were
  true, proving active native Live TV closed its ExoPlayer surface and restored
  WebView focus before Multiview mounted panes. `livePrep.ok`, `liveOpen.ok`,
  `pipFocus.ok`, and `pipOpen.ok` were also true.
- Android ExoPlayer proof in the same run: 20 Live TV zaps, two PiP guide
  loops, 10 VOD seeks, `logScan.fatal = false`, and
  `logScan.providerProtection = false`.
- CC route proof in the same run used a local Wyzie-compatible no-results mock
  (`TRIBOON_WYZIE_KEY` + `WYZIE_BASE`) so no real subtitle secret was exposed;
  the Android stress subtitle check returned HTTP 404 with `code =
  no_subtitles`, which is the expected clean title-level miss.
- Post-install focused APK proof:
  `bench/stress-results/android-tv-stress-20260626-154349.json` passed after
  `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.

2026-06-26, v1.7.29 Multiview Android correction:

- `npm.cmd run verify:full` passed with `TRIBOON_ADB_DEVICE=emulator-5554`.
- Android TV stress output:
  `bench/stress-results/android-tv-stress-20260626-144908.json`.
- Android Live TV Multiview launcher proof on `emulator-5554`: `livePrep.ok`,
  `liveOpen.ok`, `pipFocus.ok`, and `pipOpen.ok` were all true. The Live TV
  toolbar button focused as `chMultiBtn`; D-pad OK entered `S.view =
  multiview`; PiP guide D-pad Up focused `pgMultiBtn`; D-pad OK entered
  Multiview from the PiP guide.
- Android ExoPlayer stress proof in the same run: 20 Live TV zaps, two PiP
  loops, 10 VOD seeks, subtitle request HTTP 200, and `logScan.fatal = false`.
- In-app browser DOM proof on `http://localhost:7777/#/livetv`: the visible
  Live TV page exposed `button aria-label="Open multiview"` / `Multiview`.
  Browser-control click automation timed out in the control layer, so this run
  does not claim an additional manual Web Player click smoke beyond the
  automated web/inline-script and Android WebView Multiview checks.

## Critical Contracts

Before editing playback-adjacent areas, read the matching contract:

- IPTV / Live TV: `docs-player-regression-map.md` P9.
- Subtitles / CC: `docs-player-regression-map.md` P11.
- Fast VOD startup / buffering: `docs-player-regression-map.md` P14 and
  `docs-streaming-performance.md`.
- Android native player: `docs-android-tv-testing.md`.
- Release/update packaging: `docs-app-updates.md`.

## Focused Gates

The full command runs these, but they are listed here so failures can be
reproduced quickly.

### IPTV / Live TV / P9

```powershell
node --test test/iptv-cache.test.js
node --test test/xmltv.test.js
node --test --test-name-pattern "iptv|IPTV|Live TV|native proxy|native" test/security.test.js
node --test --test-name-pattern "IPTV|Live TV|native Live|playChannel|guide|PiP|client correctness" test/phase4.test.js
```

Manual checks:

- Settings and Preferences can add, edit, delete, and re-add IPTV sources.
- Source ids, favorites, groups, channel caches, XMLTV caches, and Xtream guide
  caches stay source-scoped.
- Web Live TV stays inside the Triboon player.
- Android TV uses ExoPlayer and never falls back to browser Live TV.
- Native zapping releases/replaces the old stream and survives 20 Up/Down
  changes without fatal logs or stale channel ids.
- Main, split, and Multiview rapid selections are last-intent-wins; stale URL
  hydration cannot reopen an older channel or a closed pane.
- Server/account and Android device-local channel lists start concurrently,
  merge server-first, and concurrent callers join one bridge request.
- Now/next and timeline guide requests bind index plus stable channel id,
  self-heal resolvable drift, and reload the lineup on a genuine 409.
- A cold same-source guide fanout performs one XMLTV fetch; headerless
  `.xml.gz` guides decode correctly, and their expanded size is bounded.
- Non-2xx guides stay visible as refresh failures. Editing/deleting a source or
  shutting down aborts old guide work without a late cache write.
- Distinct-source XMLTV parses use the global two-worker queue; shutdown drains
  both active and queued jobs.
- Large XMLTV parsing stays in the worker and does not stall `/api/server` or an
  active player request.

### Fast VOD Startup / P14

```powershell
node --test test/e2e.test.js
node --test --test-name-pattern "warmup|prepare|startup|read-ahead|priority|buffer|4K|multi-user|concurrent VOD|loose-pack|season pack|episode pack|pack episode|exact-episode|season-zero|live-mount reuse|top-ranked|understudy|hedge|rank grace|mount deadline|master abort" test/phase2.test.js
node --test --test-name-pattern "prepare|startup|VOD pause resume|native player|ExoPlayer|seek|web VOD rebuffer" test/phase4.test.js
node --test --test-force-exit --test-name-pattern "boot: fresh server|streaming|prepare|play|route|teardown" test/security.test.js
```

Manual checks:

- Detail pages warm cheap `/api/search` results and prepare only the stable Play
  target.
- Play reuses or joins prepared/in-flight work instead of repeating search,
  probe, mount, or health-gate work.
- Startup/seek bytes outrank health, read-ahead, and background work.
- Paused warm-ahead stays low-priority and cancels on resume, seek, or close.
- 4K buffering cannot starve another user's startup or seek.
- On a configured 4K title, the Android stress/smoke helpers can be run with
  `-VodQualityRank 4`, a saved resume timestamp, and an explicit duration; they
  fail if playback does not mount a 4K-labelled source or reach that timestamp.
- A season-pack RAR/ZIP mounts and reuses only the requested episode.
- A stalled top candidate gets one 800ms hedge; a ready understudy waits at
  most 250ms for higher ranks and prevents additional source launches.
- A sustained web/native stall retries the same source/kind/timestamp once
  before release failover; a confirmed blocked health verdict advances without
  waiting, and neither path changes episode or loses the resume timestamp.

### Subtitles / CC / P11

```powershell
node --test --test-name-pattern "subs|subtitle|Wyzie|caption" test/phase2.test.js
node --test --test-name-pattern "subtitle|Subtitles|caption|CC|Wyzie|built-in|sync" test/phase4.test.js
node --test --test-name-pattern "subtitle|subtitles|Wyzie|built-in" test/security.test.js
.\android\gradlew.bat -p android testDebugUnitTest
```

Manual checks:

- Web VOD CC opens even when a release has no ready built-in captions.
- Online CC can use either the saved dashboard Wyzie key or
  `TRIBOON_WYZIE_KEY`; release smokes may point `WYZIE_BASE` at a deliberately
  supplied local Wyzie-compatible mock with a dummy key to prove the
  server/player path without exposing a real key. The public clone does not
  include a provider-mock launcher or any real subtitle credential.
- Recommended subtitles prefer the exact release/file or TV episode.
- More subtitles reveals alternatives without noisy provider-brand wording.
- Captions stay inside the video frame on desktop, TV, and mobile.
- Automatic subtitle startup and fallback do not overwrite explicit per-title
  choices.
- Native ExoPlayer subtitle overlay switches versions and sync offsets without
  rebuilding video or resetting captions to time zero.
- Native S/M/L size follows the saved preference, `<br>`/entities are cleaned,
  and no more than the last three overlapping cue texts render.
- Web captions respect mobile/TV safe areas and bounded height; with built-ins
  off, online warmup does not wait on the optional track probe.

### Windows Native Client / P15

```powershell
node --test test/windows-px8-player.test.js
node --test test/release-contract.test.js

# From the repository root. This is the same locked recipe used by CI; it
# imports MSVC, tests Rust, builds NSIS, extracts it, and byte-checks its payload.
$tag = 'v' + (Get-Content .\package.json -Raw | ConvertFrom-Json).version
powershell -ExecutionPolicy Bypass -File `
  .\clients\windows-px8\scripts\build-package.ps1 -Tag $tag
```

The normal pull-request/main/tag workflow performs the locked MSVC native build.
For a tag it must publish only the byte-identical versioned/stable installer
pair into the final whitelist. Inspect the installed payload for
`libmpv-2.dll`, `LICENSE`, `THIRD-PARTY-NOTICES.md`,
`LIBMPV-LICENSE.LGPL`, `LIBMPV-SOURCE.md`, and `RUST-DEPENDENCIES.md`. Confirm
the current graphics driver provides `C:\Windows\System32\vulkan-1.dll`; the
pinned libmpv imports it and the installer intentionally does not bundle it. A
CI runner does not replace the four Windows live-smoke rows above.

### Release Reproducibility / Privacy

```powershell
node --test test/release-contract.test.js
node --test --test-name-pattern "privacy|geolocation|proxy" test/security.test.js
```

Confirm tag/package/Android versions agree, release assets are immutable and
whitelisted, every stable/versioned alias is identical, the APK is
release-signed, Windows server dependencies and the LGPL libmpv archive are
locked, and the final publisher cannot expose a partial release. Confirm
viewer geolocation is off by default, trusted-proxy handling is explicit, and
the Settings status reflects any environment-forced state.

## Full Done Report

Every final update report and PR description must include:

- changed surface and contracts checked: P9, P11, P14, Web Player, Android
  ExoPlayer, packaging, or none;
- `npm.cmd run verify:full` result;
- focused test pass counts when a focused gate was debugged separately;
- full `npm.cmd test` result;
- Android build result;
- Android lint and native JVM unit-test results;
- release-contract and privacy-focused results when packaging/privacy changed;
- Web Player smoke result with title/channel and what was checked;
- Android ExoPlayer smoke result with device/emulator, title/channel, zap/seek
  count, and log health;
- Android phone/mobile smoke result with AVD/device, portrait UI, touch/Back,
  caption-safe-area coverage, and log health;
- Docker image build and isolated container `/api/server` smoke result;
- locked Windows installer build/runtime result and any elevated install,
  service, firewall, upgrade, or uninstall smoke not run, with reason;
- Windows client MSVC/Rust/build result, installed runtime/notices inspection,
  exact GPU/driver plus `hwdec-current`, 1080p/4K VOD, next/resume/CW,
  subtitle/audio/input, IPTV zap, clean-install/upgrade/uninstall results, and
  whether the installer was Authenticode-signed;
- anything not run, with reason and risk.

If any required line says `not run`, do not phrase the work as fully done.
