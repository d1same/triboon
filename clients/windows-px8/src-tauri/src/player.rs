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

// M2: one persistent mpv instance, embedded in the app window (wid = the main window's HWND) so video
// draws over the WebView chrome — mirroring the Android ExoPlayer handoff. Held in a static so it lives
// across command calls (dropping it would tear down the video). Guarded by the `player` feature.
#[cfg(all(feature = "player", target_os = "windows"))]
static MPV: std::sync::Mutex<Option<libmpv2::Mpv>> = std::sync::Mutex::new(None);

/// Begin native playback of a tokened stream URL.
///
/// M2: create (once) a persistent mpv embedded in the app window (wid = main window HWND) with GPU
/// hardware decode, then loadfile the URL (resuming at `start`). Reused across calls so switching
/// titles doesn't tear down the surface. Returns Err on failure so the web UI can fall back to the
/// in-page <video>.
#[tauri::command]
pub fn player_play(app: tauri::AppHandle, args: PlayArgs) -> Result<(), String> {
    #[cfg(all(feature = "player", target_os = "windows"))]
    {
        use tauri::Manager;
        let win = app.get_webview_window("main").ok_or("no main window")?;
        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        let wid = hwnd.0 as isize as i64; // embed mpv's video into our window

        let mut guard = MPV.lock().map_err(|_| "player lock poisoned")?;
        if guard.is_none() {
            let mpv = libmpv2::Mpv::with_initializer(|init| {
                init.set_property("wid", wid)?;        // draw video into the app window
                init.set_property("hwdec", "auto")?;   // GPU decode: HEVC / MPEG-2 / AV1 / HDR
                init.set_property("vo", "gpu")?;
                init.set_property("keep-open", "no")?;
                Ok(())
            }).map_err(|e| format!("mpv init: {e}"))?;
            *guard = Some(mpv);
        }
        let mpv = guard.as_ref().unwrap();
        if args.start > 0.0 {
            mpv.command("loadfile", &[args.url.as_str(), "replace", &format!("start={}", args.start)])
        } else {
            mpv.command("loadfile", &[args.url.as_str()])
        }.map_err(|e| format!("mpv loadfile: {e}"))?;
        return Ok(());
    }
    #[cfg(not(all(feature = "player", target_os = "windows")))]
    {
        let _ = (app, args);
        Err("native player not built — using in-page <video> fallback".into())
    }
}

/// Transport control from the web OSD: pause | resume | toggle | stop | seek:<seconds>.
#[tauri::command]
pub fn player_command(cmd: String) -> Result<(), String> {
    #[cfg(all(feature = "player", target_os = "windows"))]
    {
        let guard = MPV.lock().map_err(|_| "player lock poisoned")?;
        let mpv = guard.as_ref().ok_or("no active player")?;
        let r = if cmd == "pause" { mpv.set_property("pause", true) }
            else if cmd == "resume" { mpv.set_property("pause", false) }
            else if cmd == "toggle" { mpv.command("cycle", &["pause"]) }
            else if cmd == "stop" { mpv.command("stop", &[]) }
            else if let Some(s) = cmd.strip_prefix("seek:") { mpv.command("seek", &[s, "absolute"]) }
            else { return Err(format!("unknown command: {cmd}")); };
        return r.map_err(|e| e.to_string());
    }
    #[cfg(not(all(feature = "player", target_os = "windows")))]
    {
        let _ = cmd;
        Ok(())
    }
}
