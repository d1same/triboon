// Triboon PX8 bridge — injected into the loaded Triboon web UI so the EXISTING player-handoff code
// path drives libmpv, exactly like the Android shell drives ExoPlayer. PHASE-2 (see ../README.md).
//
// The web UI already gates its native handoff on a `TriboonTV`-shaped object:
//     canUseNativeVideoPlayer() === !!(window.TriboonTV && window.TriboonTV.playVideo
//         && window.TriboonTV.nativeChromeVersion && window.TriboonTV.nativeChromeVersion() >= 1)
// PX8 provides a COMPATIBLE object so no web-UI change is needed. The methods forward to the Rust
// commands (player_play / player_command via @tauri-apps/api invoke); the web UI's OSD, Continue
// Watching, Trakt heartbeats, and subtitle menus keep working unchanged.
//
// P2 wiring checklist (on a toolchain machine):
//  - import { invoke } from '@tauri-apps/api/core'
//  - playVideo(json)  -> invoke('player_play', { args: { url, start, title } })
//  - closeVideo()     -> invoke('player_command', { cmd: 'stop' })
//  - togglePlay/seek  -> invoke('player_command', { cmd: 'toggle' | `seek:${sec}` })
//  - Rust posts progress -> window.__px8VideoProgress(pos,dur) / __px8VideoEnded() which this shim
//    forwards into the web UI's existing __tvNativeVideoProgress / __tvNativeVideoClosed handlers.
//
// NOTE (design decision to settle in P2): desktop is mouse+keyboard, not a D-pad. The Android
// handoff also toggles TV chrome/spatial-nav; PX8 must adopt the native VIDEO handoff WITHOUT the
// TV D-pad assumptions (keep the browser player chrome, just swap the video surface for libmpv).
// That is the main non-trivial integration task and why the player is a phased effort, not a shim.

(function () {
  'use strict';
  if (window.TriboonPX8) return;
  window.TriboonPX8 = {
    nativeChromeVersion: function () { return 0; }, // becomes >=1 in P2 once libmpv playback is real
    playVideo: function (_json) { return false; },  // P2: hand off to libmpv via invoke('player_play')
    closeVideo: function () {},
    // ...transport + track methods mirroring TriboonTV, filled in P2.
  };
})();
