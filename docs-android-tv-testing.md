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

## Build

Use the repo-pinned Gradle wrapper unless a current external Gradle is installed:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
.\android\gradlew.bat -p android assembleDebug
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
- Live TV guide: open `#/livetv`, hold Down in the category rail, and confirm focus stays in categories. Press Right explicitly to enter channels.
- PiP guide: open the player guide from native playback, confirm the PiP window appears over the guide background, then repeat the category-rail Down test.
- Live channel start: on Xtream lines, confirm channel API rows expose `video/mp2t` as the primary native MIME and `application/x-mpegURL` as fallback. Real-provider measurement on 2026-06-19 showed TS first-byte around 0.6s on sampled channels, while HLS often took 2-8.5s.
- Live zapping: while playing native Live TV, press Up/Down and confirm the old ExoPlayer is released before the new one initializes in logcat.
- VOD native player: start a movie, confirm duration/end time appears, Left/Right on the button row moves focus, seek-bar mode scrubs only from the seek bar, and Back hides controls before closing playback.
- Subtitles: for movies and TV episodes, verify the first recommended subtitle matches the mounted release/file or exact episode, More subtitles reveals alternates, and changing versions after resume/seek does not restart captions from time zero.
- Back behavior: from Movies, TV Shows, and attached-library grids, Back first opens that section rail/menu. A second Back returns Home.

## Real Device Note

The local Shield is currently visible to ADB as:

```text
10.1.20.11:5555
```

Use a real LAN server address for physical devices, not `10.0.2.2`. The `10.0.2.2`
address is emulator-only.
