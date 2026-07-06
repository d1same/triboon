// Triboon PX8 — native Windows GPU client. PHASE-1 SCAFFOLD (see ../README.md).
// This file has NOT been compiled on the scaffolding machine (no Rust toolchain there). It is a
// reviewed starting point for P1 (window + connect + load the server's Triboon web UI). The libmpv
// player (P2+) lives in player.rs behind the `player` feature.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::fs;
use std::sync::Mutex;
use tauri::{Manager, State};

mod player;

// Remembered server address (owner chose "enter server address"): persisted so relaunch skips the
// connect screen. Held in memory for the session; mirrored to a file in the app config dir.
#[derive(Default)]
struct AppState {
    server: Mutex<Option<String>>,
}

fn config_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("server.txt"))
}

/// The connect screen calls this with the normalized base URL. P1: remember it + navigate the
/// window to the Triboon web UI. (Reachability is validated in the UI via /api/server; a native
/// re-check can be added here.)
#[tauri::command]
fn connect(app: tauri::AppHandle, state: State<AppState>, server: String) -> Result<(), String> {
    let server = server.trim().trim_end_matches('/').to_string();
    if !(server.starts_with("http://") || server.starts_with("https://")) {
        return Err("invalid server address".into());
    }
    *state.server.lock().unwrap() = Some(server.clone());
    if let Some(p) = config_path(&app) {
        let _ = p.parent().map(fs::create_dir_all);
        let _ = fs::write(&p, &server);
    }
    let win = app.get_webview_window("main").ok_or("no main window")?;
    win.navigate(server.parse().map_err(|_| "bad url".to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// UI helper: the last server we connected to (prefills the connect field / enables auto-connect).
#[tauri::command]
fn last_server(app: tauri::AppHandle, state: State<AppState>) -> Option<String> {
    if let Some(s) = state.server.lock().unwrap().clone() {
        return Some(s);
    }
    config_path(&app).and_then(|p| fs::read_to_string(p).ok()).map(|s| s.trim().to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            last_server,
            player::player_play,
            player::player_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Triboon PX8");
}
