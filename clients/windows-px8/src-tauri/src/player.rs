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

/// Begin native playback of a tokened stream URL.
///
/// M1 (this pass): minimal real libmpv call so the CI build actually links libmpv-2.dll and we prove
/// the toolchain end-to-end. It creates an mpv instance with GPU decode, loadfile's the URL, seeks to
/// the resume point, and leaks the handle so mpv keeps its own window open (single-shot proof-of-life).
/// M2 replaces the leak with a persistent, controllable instance embedded (wid) in the app window.
#[tauri::command]
pub fn player_play(_args: PlayArgs) -> Result<(), String> {
    #[cfg(feature = "player")]
    {
        use libmpv2::Mpv;
        let mpv = Mpv::new().map_err(|e| format!("mpv init: {e}"))?;
        let _ = mpv.set_property("hwdec", "auto");       // GPU hardware decode (HEVC/MPEG-2/AV1/HDR)
        let _ = mpv.set_property("force-window", "yes"); // M1: mpv owns a window; M2 embeds via wid
        mpv.command("loadfile", &[_args.url.as_str()]).map_err(|e| format!("mpv loadfile: {e}"))?;
        if _args.start > 0.0 {
            let _ = mpv.command("seek", &[&format!("{}", _args.start), "absolute"]);
        }
        std::mem::forget(mpv); // keep the instance (and its window) alive past this call — M1 only
        return Ok(());
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
