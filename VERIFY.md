# Verify Before Any Update

This is the single verification gate for Triboon. Use it before pushing,
publishing, tagging, or telling the owner a fix is done.

If this file disagrees with another `.md`, this file wins. Update this file
first, then update the supporting doc.

## Hard Stop Rules

- Do not push or say "fixed" while a required gate is failing.
- Do not weaken or delete a failing test. Fix the product or call out the
  blocker.
- Do not claim Web Player or Android ExoPlayer coverage from code inspection
  alone.
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
- Android lint, native JVM unit tests, and debug build;
- Android TV stress smoke when an ADB device is available or supplied.

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
| Web Live TV | Channel starts in Triboon's web player, retunes cleanly, and shows live-specific errors instead of a generic external-player panel. |
| Android ExoPlayer VOD | Movie or episode opens the native branded loader and ExoPlayer surface, not the web video shell; seek does not show the full startup loader. |
| Android ExoPlayer Live TV | Native Live TV uses ExoPlayer, survives at least 20 Up/Down zaps, and logcat has no fatal/provider-loop markers. |
| CC/subtitles | Web and native CC choices open; recommended row is sane; captions stay in-frame; sync/version changes do not restart video or reset captions to time zero. |
| Fast startup | A warm prepared movie or episode starts through the reuse path, not a repeated search/probe/mount/health gate. Healthy warm sources should stay near the 1-2 second target. |
| Warm next episode | At 90 seconds remaining, the exact next S/E is prepared once. Manual/autoplay next joins that work and the prewarmed local lookup; it does not repeat the indexer/NZB/mount path. Out-of-order metadata from an older episode cannot replace the current player's next target. |

If a live smoke cannot run, the final report must say `not run`, explain why,
and describe the risk.

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
- The device run used a disposable re-keyed QA data directory with no production
  users, watch history, Trakt tokens, or music tokens; the directory is removed
  after release verification.

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
- A sustained web stall retries the same source/kind/timestamp before release
  failover.

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
  `TRIBOON_WYZIE_KEY`; release smokes may point `WYZIE_BASE` at a local mock
  from `node bench/mock-wyzie.js` with a dummy key to prove the server/player
  path without exposing a real key.
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

### Release Reproducibility / Privacy

```powershell
node --test test/release-contract.test.js
node --test --test-name-pattern "privacy|geolocation|proxy" test/security.test.js
```

Confirm tag/package/Android versions agree, release assets are immutable and
whitelisted, APK aliases are identical and release-signed, Windows dependencies
are locked, and the final publisher cannot expose a partial release. Confirm
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
- anything not run, with reason and risk.

If any required line says `not run`, do not phrase the work as fully done.
