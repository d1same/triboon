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

### Latest Evidence

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
