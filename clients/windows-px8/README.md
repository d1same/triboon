# Triboon for Windows

Triboon for Windows is the production x64 desktop client for Windows 10 and
Windows 11. It reuses the same server-hosted Triboon interface as the browser
and Android apps, but hands video playback to a persistent native libmpv
surface. The Windows server installer under `installer/windows/` is a separate
product.

Public availability is a release outcome, not a source-code claim. A client is
publishable only after the native build, automated contracts, real playback
smokes, and the release checklist in `VERIFY.md` pass for the exact tag commit.

## Runtime architecture

1. The bundled connect page accepts and validates a Triboon server origin.
   Only the origin is persisted; credentials and stream tokens are not stored
   by the desktop shell.
2. WebView2 loads the normal Triboon web UI from that exact origin. Browsing,
   search, settings, source selection, Continue Watching, and guide state stay
   owned by the shared web application.
3. A narrow `window.TriboonTV` bridge is injected only for the configured
   Triboon origin. The remote page does not receive the general Tauri API.
4. VOD or Live TV playback opens the dedicated native player window. One
   long-lived libmpv owner handles play, pause, seek, source replacement,
   subtitles, audio tracks, progress, buffering, and terminal events. Episode
   replacement reuses that surface so show details never flash between
   episodes.
5. Every callback carries the current playback token. Stale progress, error,
   close, subtitle, and next-episode events from an old item are ignored by the
   shared web state machine.

The bridge accepts only schema-bounded commands and media/subtitle URLs owned
by the configured Triboon server. Logs and errors must redact query strings so
`?t=<stream-token>` and other credentials cannot leak into support output.

## GPU playback contract

The client uses mpv's D3D11 renderer and requests safe automatic hardware
decoding. NVIDIA, AMD, and Intel decoding are all supported when the installed
driver exposes a compatible decoder; unsupported codecs or profiles fall back
to software instead of failing playback.

Requesting hardware decoding is not proof that it is active. The diagnostics
panel must report mpv's runtime decoder state (including `hwdec-current`), video
codec, renderer, dimensions, dropped frames, position, and buffer. A test may
claim GPU decode only when `hwdec-current` reports a real hardware path while
frames advance. CI can prove the native client compiles and packages; it cannot
prove a GitHub runner's virtual display used a physical decoder.

HDR output is automatic where the GPU, driver, display, operating-system HDR
setting, codec, and source all support it. Dolby Vision and lossless audio
passthrough are hardware-chain dependent and are never universal guarantees.
Bitstream passthrough is opt-in; the safe default is decoded PCM audio.

The pinned libmpv build imports the Windows Vulkan loader (`vulkan-1.dll`) even
when Triboon renders through D3D11. A current NVIDIA, AMD, or Intel graphics
driver (or its matching Vulkan Runtime) must therefore provide
`C:\Windows\System32\vulkan-1.dll`. Triboon does not bundle a copy of the
driver/runtime loader. If it is absent, update the graphics driver before
installing the client; the application cannot load libmpv without it.

## Playback parity

The Windows release gate covers the same shared contracts as Android:

- direct play, remux, then transcode fallback;
- prepared-source reuse and fast first frame;
- pause/resume, quiet seeks/skips, buffering recovery, and source retry;
- accurate resume and final Continue Watching checkpoints;
- token-safe manual/autoplay next episode with no details-page flash;
- quality, audio, subtitle version/sync/size, and episode selection;
- native HLS/TS Live TV with ordered server fallback and rapid retuning;
- mouse, keyboard, media keys, fullscreen, D-pad/controller, Back, and guide
  behavior.

See `docs-player-regression-map.md` P15 and `VERIFY.md` for the normative and
live acceptance checks.

## Build locally

Required on Windows x64:

- Node.js 24 and `npm`;
- Rust stable for `x86_64-pc-windows-msvc`;
- Visual Studio 2022 Build Tools with Desktop development with C++;
- the WebView2 Runtime;
- 7-Zip (used to inspect the NSIS payload after the build).

Local and CI builds use the same fail-closed script. It downloads the immutable
LGPL libmpv archive, verifies both its archive and DLL SHA-256, generates the
MSVC import library, records the locked Rust dependency/license inventory, runs
the Rust tests, builds the NSIS installer, extracts that installer with 7-Zip,
checks the embedded application metadata, and byte-compares every required
runtime/legal resource against the staged inputs. Tauri intentionally patches
bundle metadata into the embedded executable, so that file is checked by unique
name, size, x64 PE machine type, and product/file version instead of against the
pre-bundle hash.

```powershell
# From the repository root. A normal PowerShell window is sufficient; the
# script imports the installed MSVC x64 environment itself.
powershell -ExecutionPolicy Bypass -File .\clients\windows-px8\scripts\build-package.ps1

# A release build additionally creates the versioned alias and rejects a tag
# that does not match package/Cargo/Tauri version 2.8.1.
powershell -ExecutionPolicy Bypass -File .\clients\windows-px8\scripts\build-package.ps1 -Tag v2.8.1
```

The default output is `dist\windows-client\Triboon-Windows-Client.exe`; a tag
build also emits `Triboon-Windows-Client-vX.Y.Z.exe` and proves the pair is
byte-identical. Use `-CacheDirectory` and `-ArtifactDirectory` to relocate only
those two build outputs. `-SkipTests` exists for packaging diagnostics, never
for a release.

The public installer is currently unsigned unless the owner supplies a trusted
Windows code-signing certificate through protected CI secrets. Windows may show
a SmartScreen warning for an unsigned release. Never place a certificate,
private key, or password in this repository.

## Distribution and LGPL replacement

The release publishes byte-identical versioned and stable installer names:

```text
Triboon-Windows-Client-vX.Y.Z.exe
Triboon-Windows-Client.exe
```

The dynamically linked LGPL libmpv runtime is not modified or statically linked
into Triboon. Users may replace `libmpv-2.dll` in the installed application
directory with a compatible x64 build while Triboon is stopped. The validated
installer payload contains `libmpv-2.dll`, Triboon's `LICENSE`,
`THIRD-PARTY-NOTICES.md`, `LIBMPV-LICENSE.LGPL`, `LIBMPV-SOURCE.md`, and the
generated `RUST-DEPENDENCIES.md` inventory beside the executable. See
`LIBMPV-SOURCE.md` for the exact binary hash, upstream source revisions, and
rebuild route.
