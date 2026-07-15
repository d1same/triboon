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
  <a href="https://github.com/d1same/triboon/pkgs/container/triboon">Container image</a>
  |
  <a href="#quick-start">Quick start</a>
  |
  <a href="docs-setup.md">Setup guide</a>
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
- Wyzie and optional OpenSubtitles captions, audio-track selection, subtitle
  sync, Trakt import/export, Music, Android TV shell, and Unraid-friendly
  Docker hosting.
- Multi-user profiles, invite links, Quick Connect, profile PINs, and encrypted
  settings.

## Quick Start

Docker is the easiest way to run Triboon. The public image supports
`linux/amd64` and `linux/arm64`:

```bash
docker run -d --name triboon --restart unless-stopped -p 7777:7777 -v triboon-data:/data ghcr.io/d1same/triboon:latest
```

See the [public container package](https://github.com/d1same/triboon/pkgs/container/triboon)
for versioned image tags. The named volume is important: `/data` contains the
generated server secret and all persistent application state.

Open:

```text
http://localhost:7777
```

Then:

1. Create the owner account immediately from a trusted LAN device.
2. Open Settings.
3. Add TMDB, usenet, and a Newznab-compatible indexer.
4. Optionally add a Wyzie key, OpenSubtitles, Trakt, local libraries, music, or
   Live TV.
5. Browse and press Play.

The first-owner setup route is intentionally open only while no users exist, so
do not expose port 7777 to the Internet before creating the owner. Triboon
serves plain HTTP itself. For remote access, finish setup on the trusted LAN
first, then use a VPN or an HTTPS reverse proxy; enable `TRIBOON_TRUST_PROXY=1`
only when that proxy strips client-supplied forwarding headers.

New to this? The [Setup guide](docs-setup.md) walks through getting each API key
(TMDB, indexers, subtitles, Trakt, Live TV) step by step, with links and which
are free.

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

One stable Windows server installer ships on every release. It has a fixed
"latest" download plus a versioned copy you can pin or roll back to.

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

### Experimental client preview

The PX8/Tauri client is available only as a manual GitHub Actions preview
artifact. It is not attached to stable releases and has no fixed latest URL.
The current shell still uses web playback because its native playback bridge is
not complete; the separate libmpv experiment is also preview-only.

The Windows server installer and preview artifacts are currently unsigned, so
Windows SmartScreen shows a warning on first run - choose
**More info -> Run anyway**. Each stable release keeps this versioned server
copy for history and rollback:

```text
Triboon-Windows-Server-vX.Y.Z.exe
```

## Unraid

Use the published image:

```text
ghcr.io/d1same/triboon:latest
```

Package details and versioned tags are available on the
[public GitHub container page](https://github.com/d1same/triboon/pkgs/container/triboon).

Recommended mappings:

- `/data` -> `/mnt/user/appdata/triboon`
- Optional local media share -> `/media` as read-only

Recommended environment:

- `PUID` and `PGID` for your Unraid user/group
- `UMASK`
- `TRIBOON_SECRET` is optional. When it is unset, Triboon generates a secret
  once and stores it in persistent `/data/secret.json`. If you provide one,
  keep it stable: changing or losing it invalidates signed sessions and makes
  the existing encrypted settings unreadable.
- `TRIBOON_WYZIE_KEY` optionally supplies the server-side Wyzie Subs key without
  storing it in the dashboard settings

The [Unraid template](unraid/triboon.xml) uses the public image. Use its
[canonical raw URL](https://raw.githubusercontent.com/d1same/triboon/main/unraid/triboon.xml)
when an Unraid template-repository field needs a remote address.

## Security And Privacy

- Provider/indexer keys, IPTV credentials, Trakt tokens, subtitle credentials,
  and imported YouTube Music cookie sessions live in AES-256-GCM encrypted
  settings. User names, password hashes, watch history, library metadata, and
  thumbnails are persistent application data but are not encrypted by Triboon;
  protect `/data`, its filesystem permissions, and its backups accordingly.
- The public container image contains application files only. It does not
  contain an owner's `/data`, credentials, signing keys, or local environment
  files; those enter only at runtime through the dashboard, the mounted data
  folder, or explicitly configured environment variables.
- API routes are deny-by-default and covered by route tests.
- Stream URLs use signed, scoped tokens.
- IPTV/provider URLs with credentials are redacted from logs and caches.
- Viewer city/country lookup is off by default. Enabling it in Settings (or
  forcing `TRIBOON_VIEWER_GEO=1`) sends a remote viewer's public IP to
  `ipwho.is`; raw IPs are not written to persistent activity history or
  returned to clients. `X-Forwarded-For` is ignored unless
  `TRIBOON_TRUST_PROXY=1`, which should be enabled only behind a trusted proxy
  that strips client-supplied forwarding headers.
- Android cloud backup and device transfer exclude saved server/login state and
  device-local IPTV credentials; reconnect explicitly after a restore.
- Local runtime data, logs, old APKs, secrets, and personal screenshots/test
  captures must stay out of git. Use ignored scratch directories such as
  `tmp/` for disposable local artifacts.
- Development-only test/demo folders are excluded from GitHub source archives.

Report vulnerabilities through the private process in
[`SECURITY.md`](SECURITY.md), never through a public issue containing secrets.

Do not commit your `data/` folder, `.env` files, API keys, cookies, provider
credentials, logs, or personal media/test captures.

## Development

The server intentionally keeps runtime dependencies light: Node 24 LTS and the
standard library in `server/`, with approved external binaries such as ffmpeg
and yt-dlp. Docker also includes `ytmusicapi` for faster YouTube Music catalog
search/radio metadata. Public search and radio need no account. Personal
playlists use a per-user exported YouTube `cookies.txt` session imported from
Preferences. Triboon encrypts the cookie text in settings, then on first use
keeps one mode-0600 temporary file per linked user for the server process
lifetime. Replacing/unlinking the session and graceful shutdown remove it; a
crash can leave it for host temporary-directory cleanup, so protect that
directory too. Cookie sessions can expire and then must be re-exported. Bare
installs can add the helper with `python -m pip install ytmusicapi==1.12.1` or
use the slower `yt-dlp` catalog fallback. Playback resolution still uses
`yt-dlp`.

Run the app locally:

```bash
npm start
```

To build the current checkout in Docker instead of using the published image:

```bash
docker compose up --build
```

Run the full pre-update gate before pushing or calling a fix done:

```bash
npm.cmd run verify:full
```

Use `npm test` for the explicitly enumerated, sequential top-level Node test
suites by themselves. The release contract keeps that list synchronized with
every checked-in `test/*.test.js` file and excludes fixture generators.
`VERIFY.md` is the single
source of truth for the full gate, including IPTV, fast VOD startup, CC, Web
Player, and Android ExoPlayer smokes.

Run Android lint, native JVM unit tests, and build the debug APK:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
gradle -p android lintDebug testDebugUnitTest assembleDebug
```

The APK output is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

If a current external Gradle is not installed, use the pinned wrapper from the
repository root:

```powershell
.\android\gradlew.bat -p android lintDebug testDebugUnitTest assembleDebug
```

## Project Map

- `server/` - API, auth, source search, usenet streaming, IPTV, subtitles,
  Trakt, remux/transcode, persistence, and static serving.
- `web/index.html` - the single-file web UI used by browser, desktop wrapper,
  and Android WebView shell.
- `android/` - Android TV shell with D-pad bridge and native Media3/ExoPlayer.
- `clients/windows-px8/` - experimental Tauri/PX8 Windows preview; not a stable
  release asset until the native playback bridge is complete.
- `installer/windows/` - one-click Windows server installer (Inno Setup + service
  wrapper); build with `installer/windows/build-installer.ps1`.
- `unraid/` - Unraid template.
- [`docs-setup.md`](docs-setup.md) - first-run services, keys, and account setup.
- [`docs-architecture.md`](docs-architecture.md) - deeper architecture and
  data-flow notes.
- [`docs-streaming-performance.md`](docs-streaming-performance.md) - canonical startup, buffering, provider
  capacity, and multi-user performance contract.
- [`docs-continue-watching.md`](docs-continue-watching.md) - resume, next-up, checkpoint, and quality-carry
  contract.
- [`docs-player-regression-map.md`](docs-player-regression-map.md) - player
  behavior contracts and regression checklist.
- [`docs-app-updates.md`](docs-app-updates.md) - Android, Windows, container,
  and release publication contract.
- [`VERIFY.md`](VERIFY.md) - required pre-update verification gate.

## Legal

Triboon source is available under the [MIT License](LICENSE). Bundled external
tools retain their own licenses; see
[Third-Party Notices](THIRD-PARTY-NOTICES.md).

Triboon is for legally obtained content only. You are responsible for the
providers, playlists, indexers, files, and accounts you configure.
