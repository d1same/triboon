# Triboon Windows server installer

A one-click `Triboon-Setup-vX.Y.Z.exe` that lets a non-technical person host Triboon on a Windows
10/11 (x64) machine. They run the installer, then do everything else — providers, indexers, TMDB,
libraries, Live TV — in the browser at `http://localhost:7777`, exactly like the Unraid setup.

**Nothing else to install.** The installer bundles the Node runtime and every sidecar binary, and
registers Triboon as a background Windows service. No Node, no ffmpeg, no npm, no console window.

The browser is the client. This installer packages only the **server**.

---

## What ends up on the user's machine

| Location | Contents |
|---|---|
| `C:\Program Files\Triboon\` | `node.exe`, `server\`, `web\`, `triboon-service.exe` (WinSW) + `.xml`, `bin\` (ffmpeg, ffprobe, yt-dlp, alass), `licenses\` |
| `C:\ProgramData\Triboon\data\` | All user state: encrypted settings, watch state, library DB, thumbs. **Preserved on upgrade and uninstall.** |
| Windows Services | `Triboon` — Automatic (Delayed Start), restart-on-crash |
| Windows Firewall | one inbound allow rule for `node.exe`, **private + domain profiles only** (never public) |

The service runs the exact same `node server\index.js` as every other deployment — the server needs
**zero code changes** to run on Windows. All persistent writes already route through `TRIBOON_DATA`,
all temp writes use the OS temp dir, and each sidecar honours an env-var override
(`FFMPEG_PATH` / `FFPROBE_PATH` / `YTDLP_PATH` / `ALASS_PATH`) that the service points at `bin\`.

---

## Building the installer (maintainer, on a Windows box)

**Prereq:** [Inno Setup 6.3+](https://jrsoftware.org/isdl.php) — `winget install JRSoftware.InnoSetup`.

```powershell
# from the repo root
powershell -ExecutionPolicy Bypass -File installer\windows\build-installer.ps1
```

The script:
1. resolves the latest **Node v24 LTS** from `nodejs.org/dist/index.json`, downloads the win-x64 zip,
   **verifies its SHA-256** against the official `SHASUMS256.txt`, and extracts just `node.exe`;
2. downloads **WinSW v2.12.0** (`WinSW-x64.exe`, self-contained — no .NET runtime needed);
3. downloads **ffmpeg + ffprobe** (gyan.dev release-essentials) and **yt-dlp** (latest);
4. downloads **alass v2.0.0** (skip with `-NoAlass`);
5. copies `server\`, `web\`, `package.json`;
6. compiles `dist\Triboon-Setup-v<version>.exe` with Inno Setup.

Downloads are cached in `installer\windows\staging\downloads\` (reused on rebuild; `-Clean` wipes them).
`staging\` and `dist\` are git-ignored — only the three source files (`Triboon.iss`,
`triboon-service.xml`, `build-installer.ps1`) are committed.

Flags: `-NoAlass`, `-Clean`, `-IsccPath "<path to ISCC.exe>"`.

---

## Verifying a build (do this once per release)

Install-time end-to-end can't be fully checked from CI — run it on a real box:

1. Run `Triboon-Setup-vX.Y.Z.exe`. On an unsigned build SmartScreen shows **"Windows protected your
   PC"** → click **More info → Run anyway** (see below).
2. After install, `services.msc` → **Triboon** should be **Running**.
3. Browser → `http://localhost:7777` loads the first-run setup.
4. Configure a usenet provider + indexer + TMDB, then **press play on a real title** — this is the
   real gate, because it exercises ffmpeg (remux/transcode) spawned by the service account.
5. From another device on the LAN, open `http://<this-pc-name-or-ip>:7777` to confirm the firewall rule.
6. Re-run the same (or a newer) installer → it stops the service, replaces files, restarts — data intact.
7. Uninstall → the service and firewall rule are removed, but `C:\ProgramData\Triboon` **remains**.

---

## Notes & honest caveats

- **Other devices** reach the server at `http://<PC-name>:7777` or `http://<LAN-IP>:7777`. Tell the
  host their machine's address; the installer opens `localhost` only.
- **Unsigned installer → SmartScreen.** Until the installer is code-signed, each new build shows the
  "unknown publisher" warning; users click **More info → Run anyway** (or right-click the `.exe` →
  Properties → **Unblock**). The only true fix is a code-signing certificate — a future step. Never
  tell users to disable SmartScreen globally.
- **ffmpeg is GPLv3.** Triboon stays MIT because it only spawns ffmpeg as a separate subprocess (mere
  aggregation). The bundled binary ships with its license/attribution in `licenses\ffmpeg\` and a
  source link in `licenses\THIRD-PARTY-NOTICES.txt`. To avoid redistributing GPL binaries entirely,
  a future option is to download ffmpeg at first-run instead of bundling it.
- **Supply-chain integrity:** every bundled binary is SHA-256 verified at build time — Node, ffmpeg,
  and yt-dlp against the provider's freshly-fetched checksum; WinSW and alass against pinned constants
  in `build-installer.ps1`. A tampered download fails the build instead of shipping.
- **Data-dir ACL:** the installer runs `icacls` to break inheritance on `C:\ProgramData\Triboon` and
  grant Full Control only to `SYSTEM` + `Administrators`, so the token-signing `secret.json` isn't
  readable by other local users (NTFS ignores the server's POSIX `0600` mode).
- **Service account:** runs as `LocalSystem` (WinSW default) so it has network access, can write
  `ProgramData`, and can spawn ffmpeg. A future hardening step is a lower-privilege virtual service
  account (`NT SERVICE\Triboon`).
- **Config drift guard:** `test/windows-installer.test.js` fails if the service XML stops matching the
  env-var names the server actually reads, or if the installer loses its admin/firewall/keep-data
  guarantees.
