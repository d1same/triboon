# Triboon PX8 — native Windows GPU client

**Status: experimental preview, not a stable release asset.** The P1 WebView
shell has a dispatch-only CI build path and still uses web playback. A separate
`native_client=true` dispatch builds the libmpv feature experiment, but that is a
build artifact rather than proof of an integrated player. The web-to-native
bridge and end-to-end GPU/hardware behavior remain unverified.

## Why PX8 exists (and why it is NOT just "the browser")

On Windows the browser already is a capable Triboon client — Chrome/Edge hardware-decode
H.264/HEVC/VP9/AV1 through the GPU and play everything the web player supports. PX8's native
roadmap earns its keep only by adding things a browser cannot:

- **True direct play** of the original file (no server remux) via libmpv.
- **HDR / Dolby Vision passthrough** to an HDR display.
- **Audio bitstream passthrough** — Dolby Atmos / TrueHD / DTS-HD MA sent untouched to an AVR
  (browsers downmix to stereo; even the Android app re-encodes in most paths).
- **Precise seeking + frame-accurate playback** on any container, using the GPU.

If those don't matter for a given setup, the WebView2 shell (or just a browser) is the lighter
answer. PX8 is for the home-theater tier.

## Target architecture — reuse everything, hand off playback

PX8 is a **Tauri v2** desktop app. It is deliberately thin, exactly like the Android TV shell:

1. A first-run **connect screen** (`ui/connect.html`) captures the Triboon **server URL** (+ optional
   Quick Connect code) and remembers it. One build works against any server — localhost, LAN, or
   remote — chosen by the user (owner's decision).
2. The Tauri **WebView2** window then loads the Triboon web UI straight from that server
   (`http://<server>/`). All browsing, search, settings, Live TV, subtitles, Continue Watching —
   the entire existing UI — is reused as-is. No UI is reimplemented.
3. The target JS **bridge** (`ui/bridge.js`) mirrors the Android `TriboonTV`
   playback contract. The current bridge is intentionally disabled
   (`nativeChromeVersion() === 0`, `playVideo() === false`), so the web UI does
   not yet hand normal playback to libmpv.
4. The feature-gated Rust **libmpv** module can play a tokened URL from the
   standalone native test. Integrating that surface with normal `/api/play`,
   transport/progress callbacks, track selection, and web player chrome remains
   P2 work.

Target: Triboon's proven web UI plus a native GPU player, connected by a thin
bridge and using the existing server APIs.

## Prerequisites (build machine)

- **Rust** (stable) via [rustup](https://rustup.rs) → `rustc`, `cargo`
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2"` (or `npm i -g @tauri-apps/cli`)
- **MSVC Build Tools** (Visual Studio Build Tools, "Desktop development with C++")
- **WebView2 Runtime** — preinstalled on Windows 10/11; the installer can bundle the bootstrapper
- **libmpv** — `libmpv-2.dll` + headers. Ship `libmpv-2.dll` next to the exe; point the
  `libmpv2` crate at the import lib during build (see `src-tauri/build.rs`).

## Build / run (once the toolchain is present)

```powershell
cd clients\windows-px8
npm ci                      # locked frontend dev deps (@tauri-apps/cli, @tauri-apps/api)
npm run tauri dev           # run against a dev build
npm run tauri build         # → src-tauri\target\release\ + an MSI/NSIS installer
```

The default output is the web-playback preview. CI publishes PX8 only as a
manual workflow artifact; do not attach it to a stable release until the native
bridge and hardware matrix are complete. The Windows *server* installer remains
a separate product under `installer\windows\`.

## Roadmap (phased — each phase is independently shippable)

- **P0 — scaffold (done)**: project skeleton, connect screen, bridge contract,
  libmpv module boundary, and build docs.
- **P1 — window + connect + web UI**: Tauri window loads the server's Triboon UI after the connect
  screen and remembers the server; no native player yet, so playback stays in the
  page `<video>`. Implemented as a manual dispatch preview artifact.
- **P2 — libmpv direct play (partial experiment)**: the feature build and
  standalone native playback test exist. Normal `playVideo` handoff, the child
  surface/chrome relationship, play/pause/seek/stop, progress callbacks, and
  real GPU/hardware validation remain incomplete. Continue Watching and Trakt
  must receive checkpoints from exactly one reporter.
- **P3 — passthrough**: `hwdec=auto` GPU decode; HDR/DV passthrough; audio bitstream passthrough
  (`audio-spdif`), all admin/user-selectable.
- **P4 — subtitles + tracks**: libmpv subtitle overlay driven by the existing Wyzie/OpenSubtitles
  VTT the server serves; audio-track + quality selection through the same web menus.
- **P5 — packaging + self-update**: signed installer, version check against the GitHub release,
  in-place update.

## Server integration points available to P2

- `POST /api/play` → returns `{ streamUrl, remuxUrl, transcodeUrl, hlsUrl, streamToken, ... }`.
  PX8 prefers `streamUrl` (rangeable direct file) for true direct play.
- Stream auth: the `?t=<token>` query token (works for any client IP/UA).
- Subtitles: `/api/subtitle/...` (embedded) and the online CC endpoints already return WebVTT.
- Watch state / Trakt: `POST /api/watch` accepts playback checkpoints. Once P2
  is complete, the bridge must report libmpv's clock exactly as the Android
  bridge reports ExoPlayer's, with only one active reporter.
