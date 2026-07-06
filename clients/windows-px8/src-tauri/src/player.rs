// libmpv-backed native player. PHASE-2+ (see ../README.md). Behind the `player` feature so the P1
// window+connect build works before libmpv is wired. The commands exist now so the JS bridge
// contract (ui/bridge.js) is stable; their bodies are filled in on a toolchain machine.
//
// Design (P2): one mpv instance owns a borderless child surface behind the WebView chrome. The web
// UI's Play handoff (bridge.playVideo) calls player_play with the tokened /api/play direct URL;
// play/pause/seek/stop route through player_command; an mpv event thread posts progress back to the
// web layer (window.__px8VideoProgress / __px8VideoEnded) so Continue Watching + Trakt heartbeats
// keep working with one reporter — exactly like the Android ExoPlayer bridge.
//
// P3 passthrough knobs (set on the mpv handle): hwdec=auto (GPU decode), target-colorspace-hint +
// HDR passthrough for HDR/DV, audio-spdif=ac3,dts,eac3,truehd,dts-hd for bitstream passthrough.

use serde::Deserialize;

#[derive(Deserialize)]
pub struct PlayArgs {
    pub url: String,
    #[serde(default)]
    pub start: f64,      // resume position (seconds)
    #[serde(default)]
    pub title: String,
}

/// Begin native playback of a tokened stream URL. P2 wires this to libmpv; today it is a no-op
/// stub so the bridge contract compiles and P1 can fall back to the in-page <video>.
#[tauri::command]
pub fn player_play(_args: PlayArgs) -> Result<(), String> {
    #[cfg(feature = "player")]
    {
        // P2: lazily create the mpv instance, apply passthrough knobs, then `loadfile <url>` and
        // seek to `start`. Return Err on failure so the web UI can fall back to server remux.
        return Err("libmpv player not yet implemented (P2)".into());
    }
    #[cfg(not(feature = "player"))]
    {
        Err("player feature not built — using in-page <video> fallback".into())
    }
}

/// Transport control from the web OSD: pause | resume | toggle | stop | seek:<seconds>.
#[tauri::command]
pub fn player_command(_cmd: String) -> Result<(), String> {
    #[cfg(feature = "player")]
    {
        return Err("libmpv player not yet implemented (P2)".into());
    }
    #[cfg(not(feature = "player"))]
    {
        Ok(())
    }
}
