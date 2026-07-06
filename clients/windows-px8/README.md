# Triboon PX8 — native Windows GPU client

**Status: phase-1 foundation (scaffold + connect UI). NOT a finished app yet.**
The real player (libmpv) integration is the multi-week work described in the Roadmap below and
must be built on a machine with the Rust/Tauri/libmpv toolchain. Nothing in `src-tauri/` has been
compiled on the machine that scaffolded it (no Rust toolchain there) — treat it as a reviewed
starting point, not verified binaries.

## Why PX8 exists (and why it is NOT just "the browser")

On Windows the browser already IS a capable Triboon client — Chrome/Edge hardware-decode
H.264/HEVC/VP9/AV1 through the GPU and play everything the web player supports. PX8 earns its
keep only by doing the things a browser cannot:

- **True direct play** of the original file (no server remux) via libmpv.
- **HDR / Dolby Vision passthrough** to an HDR display.
- **Audio bitstream passthrough** — Dolby Atmos / TrueHD / DTS-HD MA sent untouched to an AVR
  (browsers downmix to stereo; even the Android app re-encodes in most paths).
- **Precise seeking + frame-accurate playback** on any container, using the GPU.

If those don't matter for a given setup, the WebView2 shell (or just a browser) is the lighter
answer. PX8 is for the home-theater tier.

## Architecture — reuse everything, hand off playback (mirrors the Android app)

PX8 is a **Tauri v2** desktop app. It is deliberately thin, exactly like the Android TV shell:

1. A first-run **connect screen** (`ui/connect.html`) captures the Triboon **server URL** (+ optional
   Quick Connect code) and remembers it. One build works against any server — localhost, LAN, or
   remote — chosen by the user (owner's decision).
2. The Tauri **WebView2** window then loads the Triboon web UI straight from that server
   (`http://<server>/`). All browsing, search, settings, Live TV, subtitles, Continue Watching —
   the entire existing UI — is reused as-is. No UI is reimplemented.
3. A JS **bridge** (`ui/bridge.js`, injected into the Triboon page) exposes a `TriboonPX8` object
   that mirrors the Android `TriboonTV` contract the web UI already speaks (`playVideo`,
   `closeVideo`, progress callbacks, track/subtitle selection). When the user presses Play, the web
   UI calls the bridge instead of the HTML `<video>` element, and **libmpv** (native, GPU) takes
   over the video surface — the same handoff pattern ExoPlayer uses on Android.
4. **libmpv** plays the tokened stream URL the server already returns from `/api/play`
   (direct-play URL preferred; falls back to the server remux/HLS URLs). Stream auth is the
   existing `?t=` token, so no server change is required.

Net: PX8 = Triboon's proven web UI + a native GPU player, connected by the bridge. The server is
untouched.

## Prerequisites (build machine)

- **Rust** (stable) via https://rustup.rs  → `rustc`, `cargo`
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2"` (or `npm i -g @tauri-apps/cli`)
- **MSVC Build Tools** (Visual Studio Build Tools, "Desktop development with C++")
- **WebView2 Runtime** — preinstalled on Windows 10/11; the installer can bundle the bootstrapper
- **libmpv** — `libmpv-2.dll` + headers. Ship `libmpv-2.dll` next to the exe; point the
  `libmpv2` crate at the import lib during build (see `src-tauri/build.rs`).

## Build / run (once the toolchain is present)

```powershell
cd clients\windows-px8
npm install                 # frontend dev deps (@tauri-apps/cli, @tauri-apps/api)
npm run tauri dev           # run against a dev build
npm run tauri build         # → src-tauri\target\release\ + an MSI/NSIS installer
```

The output installer can be published alongside the Android APK, or folded into the existing
Inno Setup flow used for the Windows *server* (`installer\windows\`).

## Roadmap (phased — each phase is independently shippable)

- **P0 (this scaffold)**: project skeleton, connect screen, bridge contract, libmpv module stub,
  build docs. Reviewable; not yet built.
- **P1 — window + connect + web UI**: Tauri window loads the server's Triboon UI after the connect
  screen; remember the server; no native player yet (falls back to the in-page `<video>`). First
  runnable milestone.
- **P2 — libmpv direct play**: bridge `playVideo` → libmpv plays the `/api/play` direct URL on a
  borderless child surface behind the WebView chrome; play/pause/seek/stop + progress callbacks
  wired back to the web UI (Continue Watching + Trakt heartbeats keep working, one reporter).
- **P3 — passthrough**: `hwdec=auto` GPU decode; HDR/DV passthrough; audio bitstream passthrough
  (`audio-spdif`), all admin/user-selectable.
- **P4 — subtitles + tracks**: libmpv subtitle overlay driven by the existing Wyzie/OpenSubtitles
  VTT the server serves; audio-track + quality selection through the same web menus.
- **P5 — packaging + self-update**: signed installer, version check against the GitHub release,
  in-place update.

## Integration points already provided by the server (no server changes needed)

- `POST /api/play` → returns `{ streamUrl, remuxUrl, transcodeUrl, hlsUrl, streamToken, ... }`.
  PX8 prefers `streamUrl` (rangeable direct file) for true direct play.
- Stream auth: the `?t=<token>` query token (works for any client IP/UA).
- Subtitles: `/api/subtitle/...` (embedded) and the online CC endpoints already return WebVTT.
- Watch state / Trakt: `POST /api/watch` heartbeats — the bridge reports libmpv's clock exactly
  as the Android bridge reports ExoPlayer's, so no double-counting.
