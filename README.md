<p align="center">
  <img src="logo/triboon.png" alt="Triboon" width="190">
</p>

<h1 align="center">Triboon</h1>

<p align="center">
  Self-hosted streaming for movies, shows, local libraries, music, subtitles, Trakt, and Live TV.
  Press Play and Triboon finds, mounts, and streams the best healthy source.
</p>

<p align="center">
  <a href="https://github.com/d1same/triboon/releases/latest">Latest release</a>
  |
  <a href="https://github.com/d1same/triboon/releases/latest/download/triboon.apk">Android APK</a>
  |
  <a href="https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Server.exe">Windows server</a>
  |
  <a href="https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Client.exe">Windows client</a>
  |
  <a href="#quick-start">Quick start</a>
  |
  <a href="#unraid">Unraid</a>
</p>

## What It Does

Triboon is a Plex-polished, Stremio-style app you run yourself. The admin adds
providers, indexers, metadata, subtitles, Trakt, local folders, and optional
IPTV playlists. Users sign in, pick a profile, browse, and press Play.

Playback is built around speed:

```text
source-fit -> direct play -> remux -> transcode
```

That means Triboon tries to choose the right source first, direct-play whenever
the device can handle it, and only remux or transcode when the client needs
help.

Detail pages warm search results and can prepare the first viable ranked source
in the background, so pressing Play can reuse the prepared mount instead of
repeating source finding, health probing, and mount work.

## Highlights

- Movies and TV shows with TMDB metadata, detail pages, seasons, episodes,
  recommendations, cast pages, watchlist, and Continue Watching.
- Best-source search across Newznab-compatible indexers, with quality caps,
  title verification, health checks, and automatic source failover.
- Usenet streaming directly from archives while they are still remote, with
  Range seeking and resume support.
- Local libraries for owned media, with lazy loading so large folders do not
  freeze the app.
- Live TV through M3U or Xtream playlists, including source-scoped caches,
  guide data, favorites, Android TV native playback, and browser remux.
- Wyzie subtitles, audio-track selection, subtitle sync, Trakt import/export,
  Music, Android TV shell, and Unraid-friendly Docker hosting.
- Multi-user profiles, invite links, Quick Connect, profile PINs, and encrypted
  settings.

## Quick Start

Docker is the easiest way to run Triboon:

```bash
docker compose up --build
```

Open:

```text
http://localhost:7777
```

Then:

1. Create the owner account.
2. Open Settings.
3. Add TMDB, usenet, and a Newznab-compatible indexer.
4. Optionally add Wyzie subtitles, Trakt, local libraries, music, or Live TV.
5. Browse and press Play.

Plain Node also works when Node 24+ is installed:

```bash
node server/index.js
```

On Windows, the one-click [Windows](#windows) installer sets this up as an
auto-start service - no Docker or Node install required.

ffmpeg is optional but strongly recommended. Without ffmpeg, some browser or
device combinations may need external-player handoff instead of in-app remux or
transcode.

## Android APK

Triboon ships one universal APK for Android TV, phones, and tablets - the same
binary adapts at runtime. Triboon keeps a stable APK URL for in-app updates and
Downloader shortcuts. The full naming contract lives in
[`docs-app-updates.md`](docs-app-updates.md).

The stable download is always:

```text
https://github.com/d1same/triboon/releases/latest/download/triboon.apk
```

Each release also keeps a versioned copy for history:

```text
triboon-vX.Y.Z.apk
```

The APK filename does not control Android updates. Android accepts an update
when the package id and signing key match and the new `versionCode` is higher.

## Windows

Two one-click Windows builds ship on every release. Each has a stable "latest"
download plus a versioned copy you can pin or roll back to.

### Server (host Triboon on Windows)

A self-contained installer that bundles the Node 24 runtime, ffmpeg/ffprobe,
yt-dlp, and alass, registers Triboon as an auto-start Windows service, and opens
the LAN firewall on the private and domain profiles only. When it finishes you
configure everything in the browser at `http://localhost:7777`, exactly like the
Unraid setup - other devices reach it at `http://<pc-name-or-ip>:7777`.

```text
https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Server.exe
```

Your data is safe across updates. All state (encrypted settings, users, watch
history, library DB, thumbnails) lives in `C:\ProgramData\Triboon\data`, which
the installer keeps on upgrade *and* uninstall - reinstalling picks up exactly
where you left off. Updates only replace the program files under
`Program Files\Triboon`.

### Client (native Windows app)

A native window that connects to any Triboon server by address and plays through
the built-in browser engine with GPU-accelerated decode. Point it at the same
address you would open in a browser (for example `http://192.168.1.20:7777`).

```text
https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Client.exe
```

Both installers are currently unsigned, so Windows SmartScreen shows a warning
on first run - choose **More info -> Run anyway**. Each release also keeps
versioned copies for history and rollback:

```text
Triboon-Windows-Server-vX.Y.Z.exe
Triboon-Windows-Client-vX.Y.Z.exe
```

## Unraid

Use the published image:

```text
ghcr.io/d1same/triboon:latest
```

Recommended mappings:

- `/data` -> `/mnt/user/appdata/triboon`
- Optional local media share -> `/media` as read-only

Recommended environment:

- `PUID` and `PGID` for your Unraid user/group
- `UMASK`
- `TRIBOON_SECRET` so sessions and encrypted settings survive rebuilds
- `TRIBOON_WYZIE_KEY` optionally supplies the server-side Wyzie Subs key without
  storing it in the dashboard settings

The Unraid template lives in `unraid/triboon.xml`.

## Security And Privacy

- Credentials and provider settings are encrypted at rest in the data folder.
- API routes are deny-by-default and covered by route tests.
- Stream URLs use signed, scoped tokens.
- IPTV/provider URLs with credentials are redacted from logs and caches.
- Local runtime data, logs, old APKs, screenshots, and secrets are ignored by
  git.
- Development-only test/demo folders are excluded from GitHub source archives.

Do not commit your `data/` folder, `.env` files, API keys, cookies, provider
credentials, logs, or personal media/test captures.

## Development

The server intentionally keeps runtime dependencies light: Node 24 LTS and the
standard library in `server/`, with approved external binaries such as ffmpeg
and yt-dlp. Docker also includes `ytmusicapi` for faster YouTube Music catalog
search/radio metadata and Google device-code account linking; bare installs can
add it with `python -m pip install ytmusicapi==1.12.1` or skip it and fall back
to the slower `yt-dlp` search path plus manual cookies.txt linking. Playback
resolution still uses `yt-dlp`.

Run the app locally:

```bash
npm start
```

Run the full pre-update gate before pushing or calling a fix done:

```bash
npm.cmd run verify:full
```

Use `npm test` for the Node test suite by itself. `VERIFY.md` is the single
source of truth for the full gate, including IPTV, fast VOD startup, CC, Web
Player, and Android ExoPlayer smokes.

Build the Android debug APK:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
gradle -p android assembleDebug
```

The APK output is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

If a current external Gradle is not installed, use the pinned wrapper from the
`android/` folder:

```powershell
.\gradlew.bat assembleDebug
```

## Project Map

- `server/` - API, auth, source search, usenet streaming, IPTV, subtitles,
  Trakt, remux/transcode, persistence, and static serving.
- `web/index.html` - the single-file web UI used by browser, desktop wrapper,
  and Android WebView shell.
- `android/` - Android TV shell with D-pad bridge and native Media3/ExoPlayer.
- `clients/windows-px8/` - native Windows client (Tauri shell that loads the
  server UI; GPU-accelerated playback).
- `installer/windows/` - one-click Windows server installer (Inno Setup + service
  wrapper); build with `installer/windows/build-installer.ps1`.
- `unraid/` - Unraid template.
- `docs-architecture.md` - deeper architecture and data-flow notes.
- `docs-player-regression-map.md` - player behavior contracts and regression
  checklist.
- `VERIFY.md` - required pre-update verification gate.

## Legal

Triboon is for legally obtained content only. You are responsible for the
providers, playlists, indexers, files, and accounts you configure.
