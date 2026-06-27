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
- Android debug build;
- Android TV stress smoke when an ADB device is available or supplied.

The Android stress step is part of the full gate. If no Android device is
available, the gate fails. If the runner explicitly skips it, the script still
finishes as incomplete and Android ExoPlayer must be reported as unverified.

## Required Live Smokes

Automated tests cannot prove real provider playback. For playback-adjacent
changes, complete these live checks before saying the update is done:

| Area | Required proof |
| --- | --- |
| Web Player VOD | Movie starts, seeks, pauses, resumes, closes, and does not show new console errors. |
| Web Player TV episode | Correct season/episode context, resume target, Up Next behavior when relevant. |
| Web Live TV | Channel starts in Triboon's web player, retunes cleanly, and shows live-specific errors instead of a generic external-player panel. |
| Android ExoPlayer VOD | Movie or episode opens the native branded loader and ExoPlayer surface, not the web video shell; seek does not show the full startup loader. |
| Android ExoPlayer Live TV | Native Live TV uses ExoPlayer, survives at least 20 Up/Down zaps, and logcat has no fatal/provider-loop markers. |
| CC/subtitles | Web and native CC choices open; recommended row is sane; captions stay in-frame; sync/version changes do not restart video or reset captions to time zero. |
| Fast startup | A warm prepared movie or episode starts through the reuse path, not a repeated search/probe/mount/health gate. Healthy warm sources should stay near the 1-2 second target. |

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
  --title "Movie Name 2024|tt1234567" --title "Show S01E01|tt7654321|1|1"
```

It logs in, then for each title measures: **ready** (press→playable via
`/api/play`), **1stByte** (stream Range bytes=0-, the time-to-first-frame
proxy), **seek** (cold Range ~70% in), **resume** (second Play reuses the live
mount), and reports the **playback method** (direct / +aacSafe / remux /
transcode) and a live **health** verdict. Exit code is non-zero if any title
fails to produce a playable stream. Budgets default to feels-local targets
(ready≤3s, 1stByte≤1.5s) and flag `SLOW` rather than hard-failing on timing.

### Latest Evidence

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
node --test test/security.test.js --test-name-pattern "iptv|IPTV|Live TV|native proxy|native"
node --test test/phase4.test.js --test-name-pattern "IPTV|Live TV|native Live|playChannel|guide|PiP"
```

Manual checks:

- Settings and Preferences can add, edit, delete, and re-add IPTV sources.
- Source ids, favorites, groups, channel caches, XMLTV caches, and Xtream guide
  caches stay source-scoped.
- Web Live TV stays inside the Triboon player.
- Android TV uses ExoPlayer and never falls back to browser Live TV.
- Native zapping releases/replaces the old stream and survives 20 Up/Down
  changes without fatal logs or stale channel ids.

### Fast VOD Startup / P14

```powershell
node --test test/e2e.test.js
node --test test/phase2.test.js --test-name-pattern "warmup|prepare|startup|read-ahead|priority|buffer|4K"
node --test test/phase4.test.js --test-name-pattern "prepare|startup|VOD pause resume|native player|ExoPlayer|seek"
node --test test/security.test.js --test-name-pattern "streaming|prepare|play|route"
```

Manual checks:

- Detail pages warm cheap `/api/search` results and prepare only the stable Play
  target.
- Play reuses or joins prepared/in-flight work instead of repeating search,
  probe, mount, or health-gate work.
- Startup/seek bytes outrank health, read-ahead, and background work.
- Paused warm-ahead stays low-priority and cancels on resume, seek, or close.
- 4K buffering cannot starve another user's startup or seek.

### Subtitles / CC / P11

```powershell
node --test test/phase2.test.js --test-name-pattern "subs|subtitle|Wyzie|caption"
node --test test/phase4.test.js --test-name-pattern "subtitle|Subtitles|caption|CC|Wyzie|built-in|sync"
node --test test/security.test.js --test-name-pattern "subtitle|subtitles|Wyzie|built-in"
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

## Full Done Report

Every final update report and PR description must include:

- changed surface and contracts checked: P9, P11, P14, Web Player, Android
  ExoPlayer, packaging, or none;
- `npm.cmd run verify:full` result;
- focused test pass counts when a focused gate was debugged separately;
- full `npm.cmd test` result;
- Android build result;
- Web Player smoke result with title/channel and what was checked;
- Android ExoPlayer smoke result with device/emulator, title/channel, zap/seek
  count, and log health;
- anything not run, with reason and risk.

If any required line says `not run`, do not phrase the work as fully done.
