# Android TV Testing

This project opens cleanly in Android Studio from the `android/` folder. Use that folder as
the IDE project root so Studio sees the `TriboonTV` Gradle project and the `app` module.

## Local Tooling

The Windows test machine is configured with:

- Android Studio: `C:\Program Files\Android\Android Studio`
- `JAVA_HOME`: `C:\Program Files\Android\Android Studio\jbr`
- `ANDROID_HOME`: `%LOCALAPPDATA%\Android\Sdk`
- `ANDROID_SDK_ROOT`: `%LOCALAPPDATA%\Android\Sdk`
- Android SDK command-line tools installed under `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest`

The dedicated Android TV emulator is:

- AVD name: `Triboon_TV_API_36`
- Device profile: `tv_1080p`
- System image: `system-images;android-36;android-tv;x86_64`

The dedicated Android phone emulator is:

- AVD name: `Triboon_Phone_API_36`
- Device profile: Pixel 7
- System image: Android 36 `google_apis` x86_64

## Build

Use the repo-pinned Gradle wrapper unless a current external Gradle is installed:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
.\android\gradlew.bat -p android lintDebug testDebugUnitTest assembleDebug
```

APK output:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## Emulator Test Loop

Start the emulator from Android Studio Device Manager, or from PowerShell:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Triboon_TV_API_36 -netdelay none -netspeed full -no-boot-anim
```

For repeat QA after WebView/player crashes or graphics instability, start with the stable
software-rendered profile used in the v1.1.15 emulator pass:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Triboon_TV_API_36 -no-snapshot -gpu swiftshader_indirect -no-boot-anim -netdelay none -netspeed full
```

Install and launch the debug APK:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb -s emulator-5554 install -r android\app\build\outputs\apk\debug\app-debug.apk
& $adb -s emulator-5554 shell monkey -p app.triboon.tv -c android.intent.category.LAUNCHER 1
```

For an emulator talking to a Triboon server running on this Windows host, use:

```text
http://10.0.2.2:7777
```

For an isolated test server that does not touch the main `data/` folder:

```powershell
$env:PORT = '7781'
$env:TRIBOON_DATA = "$env:TEMP\triboon-android-tv-test-data"
node server/index.js
```

Then connect the Android TV app to:

```text
http://10.0.2.2:7781
```

## Logs And Screenshots

Capture a focused app log:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb -s emulator-5554 logcat -c
# reproduce the issue
& $adb -s emulator-5554 logcat -d -t 1000 |
  Select-String -Pattern 'Triboon|app\.triboon|AndroidRuntime|FATAL|ExoPlayer|chromium|WebView|ERR_' |
  Set-Content dist\android-tv-emulator.log
```

Capture a screenshot without corrupting the PNG:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb -s emulator-5554 shell screencap -p /sdcard/triboon-shot.png
& $adb -s emulator-5554 pull /sdcard/triboon-shot.png dist\android-tv-emulator.png
& $adb -s emulator-5554 shell rm /sdcard/triboon-shot.png
```

## Current QA Checklist

Use this as the minimum repeat pass after player, IPTV, subtitle, or D-pad changes:

- Home wake: leave the app idle until the screensaver appears, press OK, and confirm Home returns with the previous row/card focus intact.
- Live TV source management: in Settings, add at least one M3U or Xtream playlist through `#/settings`, confirm it appears in the playlist list, delete it, and confirm Live TV no longer shows channels or favorites from that source. If two playlists are available, add both and confirm duplicate channel names do not collide.
- Personal IPTV source management: the Preferences -> Live TV tab must stay visible on every client so users can find the feature. In a browser, add one account M3U or Xtream source, confirm it appears only for that signed-in user, and confirm Live TV loads through the server path. In the Android TV app, confirm the same account source appears, then optionally use "Save on this TV only" and confirm that device-only favorite stays local to the device.
- Live TV guide: open `#/livetv`, hold Down in the category rail, and confirm focus stays in categories. Press Right explicitly to enter channels.
- PiP guide: open the player guide from native playback, confirm the PiP window appears over the guide background, then repeat the category-rail Down test.
- Live channel start: on Xtream lines, confirm channel API rows expose `video/mp2t` as the primary native MIME and `application/x-mpegURL` as fallback. Real-provider measurement on 2026-06-19 showed TS first-byte around 0.6s on sampled channels, while HLS often took 2-8.5s.
- Live zapping: while playing native Live TV, press Up/Down and confirm the old ExoPlayer is released before the new one initializes in logcat.
- Rapid-zap intent: make several fast channel selections and confirm the last selection wins; stale main/split/Multiview hydration must not retune an older channel.
- VOD native player: start a movie, confirm duration/end time appears, Left/Right on the button row moves focus, seek-bar mode scrubs only from the seek bar, and Back hides controls before closing playback.
- Episode handoff: play an episode through its final 15 seconds and test both the Up Next Play action and autoplay. The current native frame must transition directly to the next episode's native branded loader/first frame; the TV-show details WebView must never appear between them, and EOF must not start a second 10-second countdown. Repeat with autoplay off to confirm the manual Up Next card remains on the native player. Press Back while the next episode says Preparing and confirm it returns to details once and never reopens playback when the pending lookup/mount completes.
- VOD capacity: when provider or buffering behavior changes, confirm Settings -> Streaming performance still reports the expected provider connection total and that repeated VOD seek/start actions do not wait behind background read-ahead. See `docs-streaming-performance.md`.
- Subtitles: for movies and TV episodes, verify the first recommended subtitle matches the mounted release/file or exact episode, More subtitles reveals alternates, and changing versions after resume/seek does not restart captions from time zero. Check S/M/L native caption sizes, `<br>`/entity cleanup, no more than the last three overlapping cue texts, and safe in-frame placement.
- Back behavior: from Movies, TV Shows, and attached-library grids, Back first opens that section rail/menu. A second Back returns Home.

For the phone AVD, also repeat this mobile-specific pass:

- Portrait shell: Home, a movie/show detail, Preferences/Settings, and the
  player fit without horizontal page overflow or clipped primary actions.
- Touch: the burger/menu, cards, sheets, and player controls respond to touch;
  the seek surface and interactive rows retain at least a 44px touch target.
- Back layering: system/predictive Back closes the mobile drawer, sheets,
  player controls, player, and detail page in that order before the root-level
  exit prompt.
- Captions: web/native captions stay inside the video safe area in portrait and
  landscape, long lines wrap, and S/M/L sizing does not clip or overflow.
- Logs: repeat the focused fatal/ANR/Chromium scan after navigation, rotation,
  playback, seek, and Back.

## Repeatable Stress Pass

For release hardening, run the automated Android TV stress helper against the emulator or a
connected Android TV device:

Before starting, make sure the target is online and fully booted, its configured
Triboon server is running and reachable, and the app is signed in with a profile
selected. The helper stops at this preflight when it sees an offline device, a
server error page, Setup, Login, profile selection, or PIN entry; those states
do not produce misleading page, IPTV, or VOD failures.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bench\android-tv-stress.ps1 `
  -Device emulator-5554 `
  -PageLoops 3 `
  -LiveZaps 20 `
  -PipLoops 5 `
  -VodSeeks 20 `
  -NoScreenshot
```

The stress helper itself verifies:

- Home/menu boot reaches a focusable page.
- Home, Movies, TV Shows, Watchlist, Calendar, Discover, Live TV, and Music can be opened and backed out repeatedly.
- Movies/TV Back first opens the section rail/menu, then returns Home on the next Back.
- Source selection keeps the 1080p and 4K picks separated for the same title.
- Native Live TV survives 20 Up/Down channel changes without provider-protection or fatal log markers.
- Native PiP guide opens and Back returns to fullscreen without leaving the screensaver/background behind.
- VOD survives 20 forward/rewind media-key seeks without a stuck loader.
- VOD startup/seek remains responsive while other playback/background work is active; if this fails, review provider capacity, startup reserve, and NNTP priority lanes in `docs-streaming-performance.md`.
- Online subtitle lookup returns a clean playable/miss response instead of HTTP 401.
- Native subtitle JVM tests pass through `testDebugUnitTest` before the stress run.

To exercise the specific 4K Continue Watching path on a server with a known 4K
title, add an exact key plus an explicit saved position and duration:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bench\android-tv-stress.ps1 `
  -Device emulator-5554 `
  -VodKey "tmdb:movie:YOUR_ID" `
  -VodQualityRank 4 `
  -VodResumeSeconds 2700 `
  -VodDurationSeconds 7200 `
  -VodSeeks 10 `
  -NoScreenshot
```

This opt-in path fails if the mounted source is not labelled 2160p/4K/UHD or
if native playback does not reach the saved timestamp. The same controls are
available through `verify:full` as `-AndroidVodQualityRank`,
`-AndroidVodResumeSeconds`, and `-AndroidVodDurationSeconds`; its configured
title key is `-AndroidVodKey`. The lightweight
`android-tv-smoke.ps1` uses `-VodQualityRank`, `-ResumeSeconds`, and
`-VodDurationSeconds`.

Keep the complementary checks explicit: attached-library navigation, Preferences/Settings Back,
and source add/delete are manual emulator/device checks from the checklist above. P9 Node tests own
source-scoped cache cleanup, last-intent rapid-zap races, personal-bridge single-flight loading, and
stable guide-channel identity. Emulator PiP/guide focus races are warnings in the helper; the physical
Android TV pass remains required before claiming the wider hardware matrix is verified.

Reports are written under `bench/stress-results/`; that folder is ignored by git because it can
contain machine-specific timing and provider state.

## Real Device Note

For a physical Android TV device, connect ADB normally and pass its device id with `-Device`.
Use a real LAN server address for physical devices, not `10.0.2.2`. The `10.0.2.2` address is
emulator-only.
