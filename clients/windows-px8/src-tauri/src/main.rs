//! Triboon's Windows shell.
//!
//! The catalog remains the source of truth for playback state.  A second, persistent window owns
//! the native libmpv surface and sends tokened progress back to the (hidden) catalog WebView.  The
//! remote page never receives Tauri's general API: the injected bridge exposes only the commands
//! registered below and every command checks the caller's current origin again in Rust.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde_json::json;
use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State, WebviewWindow};

mod player;

const CONNECT_WINDOW_LABEL: &str = "main";
const PLAYER_WINDOW_LABEL: &str = "player";
const MAX_SERVER_URL_LEN: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HttpUrl {
    pub(crate) scheme: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) path_and_query: String,
}

impl HttpUrl {
    pub(crate) fn origin(&self) -> String {
        let default = (self.scheme == "http" && self.port == 80)
            || (self.scheme == "https" && self.port == 443);
        // Match URL Standard/WebView2 serialization: even an explicitly written default port is
        // omitted from the canonical origin (`https://host:443` -> `https://host`).
        if default {
            format!("{}://{}", self.scheme, self.host)
        } else {
            format!("{}://{}:{}", self.scheme, self.host, self.port)
        }
    }

    pub(crate) fn normalized_url(&self) -> String {
        format!("{}{}", self.origin(), self.path_and_query)
    }
}

/// Parse and canonicalize an HTTP(S) URL with the same URL Standard implementation Tauri uses.
/// The returned host includes IPv6 brackets so `origin()` remains a valid serialized origin.
pub(crate) fn parse_http_url(raw: &str) -> Result<HttpUrl, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_SERVER_URL_LEN || raw.bytes().any(|b| b <= 0x20) {
        return Err("invalid URL".into());
    }
    let parsed = url::Url::parse(raw).map_err(|_| "invalid URL".to_string())?;
    if parsed.fragment().is_some() {
        return Err("URL fragments are not allowed".into());
    }
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("URL must use HTTP or HTTPS".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL host is invalid".into());
    }
    let host = match parsed
        .host()
        .ok_or_else(|| "URL host is invalid".to_string())?
    {
        url::Host::Domain(value) => value.to_ascii_lowercase(),
        url::Host::Ipv4(value) => value.to_string(),
        url::Host::Ipv6(value) => format!("[{value}]"),
    };
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "URL port is invalid".to_string())?;
    let mut path_and_query = parsed.path().to_string();
    if path_and_query.is_empty() {
        path_and_query.push('/');
    }
    if let Some(query) = parsed.query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    Ok(HttpUrl {
        scheme,
        host,
        port,
        path_and_query,
    })
}

fn normalize_server(raw: &str) -> Result<String, String> {
    let parsed = parse_http_url(raw)?;
    if parsed.path_and_query != "/" {
        return Err("enter only the Triboon server address, without a path or query".into());
    }
    Ok(parsed.origin())
}

#[cfg(debug_assertions)]
fn debug_smoke_server() -> Result<Option<String>, String> {
    let Ok(raw) = std::env::var("TRIBOON_WINDOWS_SMOKE_SERVER") else {
        return Ok(None);
    };
    let server = normalize_server(&raw)?;
    let parsed = parse_http_url(&server)?;
    if parsed.scheme != "http" || (parsed.host != "127.0.0.1" && parsed.host != "[::1]") {
        return Err("TRIBOON_WINDOWS_SMOKE_SERVER must be a literal loopback HTTP address".into());
    }
    Ok(Some(server))
}

fn is_internal_app_url(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    lower.starts_with("tauri://localhost/")
        || lower.starts_with("http://tauri.localhost/")
        || lower.starts_with("https://tauri.localhost/")
}

#[derive(Default)]
pub(crate) struct AppState {
    server: Mutex<Option<String>>,
    connect_url: Mutex<Option<String>>,
}

impl AppState {
    pub(crate) fn server_origin(&self) -> Option<String> {
        self.server.lock().ok().and_then(|value| value.clone())
    }

    fn set_server(&self, server: Option<String>) -> Result<(), String> {
        *self
            .server
            .lock()
            .map_err(|_| "server state is unavailable".to_string())? = server;
        Ok(())
    }

    fn remember_connect_url(&self, url: &str) {
        if is_internal_app_url(url) {
            if let Ok(mut slot) = self.connect_url.lock() {
                *slot = Some(url.to_string());
            }
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("server.txt"))
}

fn read_saved_server(app: &tauri::AppHandle) -> Option<String> {
    let raw = config_path(app).and_then(|path| fs::read_to_string(path).ok())?;
    normalize_server(raw.trim()).ok()
}

fn persist_server(app: &tauri::AppHandle, server: &str) -> Result<(), String> {
    let path = config_path(app).ok_or_else(|| "app config directory is unavailable".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "app config directory is invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("could not create app config: {e}"))?;
    let temporary = path.with_extension("txt.tmp");
    fs::write(&temporary, server).map_err(|e| format!("could not save server: {e}"))?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("could not replace saved server: {e}"))?;
    }
    fs::rename(&temporary, &path).map_err(|e| format!("could not finalize saved server: {e}"))
}

fn server_info_is_triboon(body: &[u8]) -> bool {
    if body.is_empty() || body.len() > 2 * 1024 * 1024 {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    let version_ok = object
        .get("version")
        .and_then(|v| v.as_str())
        .is_some_and(|version| {
            let mut parts = version.split('.');
            (0..3).all(|_| parts.next().is_some_and(|part| part.parse::<u64>().is_ok()))
        });
    version_ok && object.get("needsSetup").is_some_and(|v| v.is_boolean())
}

#[cfg(target_os = "windows")]
fn validate_server_reachable(server: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let endpoint = format!("{server}/api/server");
    let output = Command::new("curl.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--proto",
            "=http,https",
            "--max-redirs",
            "0",
            "--max-filesize",
            "2097152",
            "--connect-timeout",
            "3",
            "--max-time",
            "7",
            "--header",
            "Accept: application/json",
            &endpoint,
        ])
        .output()
        .map_err(|_| "Windows curl is unavailable; could not verify the server".to_string())?;
    if !output.status.success() {
        return Err("Triboon server is unreachable or rejected /api/server".into());
    }
    if !server_info_is_triboon(&output.stdout) {
        return Err("the address did not return a valid Triboon /api/server response".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn validate_server_reachable(_server: &str) -> Result<(), String> {
    Err("the native Windows server check is unavailable on this platform".into())
}

pub(crate) fn require_catalog_origin(
    window: &WebviewWindow,
    state: &AppState,
) -> Result<String, String> {
    if window.label() != CONNECT_WINDOW_LABEL {
        return Err("command is available only to the Triboon catalog".into());
    }
    let configured = state
        .server_origin()
        .ok_or_else(|| "no Triboon server is configured".to_string())?;
    let current = window
        .url()
        .map_err(|_| "could not verify the calling page".to_string())?;
    let current = parse_http_url(current.as_str())?.origin();
    if current != configured {
        return Err("untrusted page".into());
    }
    Ok(configured)
}

pub(crate) fn require_player_or_catalog(
    window: &WebviewWindow,
    state: &AppState,
) -> Result<Option<String>, String> {
    if window.label() == PLAYER_WINDOW_LABEL {
        let url = window
            .url()
            .map_err(|_| "could not verify the player page".to_string())?;
        if is_internal_app_url(url.as_str()) {
            return Ok(state.server_origin());
        }
        return Err("untrusted player page".into());
    }
    require_catalog_origin(window, state).map(Some)
}

#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    server: String,
) -> Result<(), String> {
    if window.label() != CONNECT_WINDOW_LABEL {
        return Err("invalid setup window".into());
    }
    let caller = window.url().map_err(|e| e.to_string())?;
    if !is_internal_app_url(caller.as_str()) {
        return Err("server changes must start from Triboon's local connect screen".into());
    }
    let server = normalize_server(&server)?;
    let verify = server.clone();
    tauri::async_runtime::spawn_blocking(move || validate_server_reachable(&verify))
        .await
        .map_err(|_| "server verification was interrupted".to_string())??;
    persist_server(&app, &server)?;
    state.set_server(Some(server.clone()))?;
    window
        .navigate(
            server
                .parse()
                .map_err(|_| "invalid server URL".to_string())?,
        )
        .map_err(|e| format!("could not open Triboon: {e}"))
}

/// Compatibility alias for the production bridge; both names run the same native verification.
#[tauri::command]
async fn windows_connect(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    server: String,
) -> Result<(), String> {
    connect(app, window, state, server).await
}

#[tauri::command]
fn last_server(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if window.label() != CONNECT_WINDOW_LABEL {
        return Err("invalid setup window".into());
    }
    let caller = window.url().map_err(|e| e.to_string())?;
    if !is_internal_app_url(caller.as_str()) {
        return Err("saved servers are available only to Triboon's local connect screen".into());
    }
    Ok(state.server_origin().or_else(|| read_saved_server(&app)))
}

#[tauri::command]
fn windows_change_server(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    player_state: State<'_, player::PlayerController>,
) -> Result<(), String> {
    require_catalog_origin(&window, &state)?;
    player_state.close(&app, true)?;
    state.set_server(None)?;
    if let Some(path) = config_path(&app) {
        let _ = fs::remove_file(path);
    }
    let connect_url = state
        .connect_url
        .lock()
        .ok()
        .and_then(|url| url.clone())
        .unwrap_or_else(|| "http://tauri.localhost/connect.html".to_string());
    window
        .navigate(
            connect_url
                .parse()
                .map_err(|_| "invalid connect page URL".to_string())?,
        )
        .map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn windows_native_chrome_version(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    require_player_or_catalog(&window, &state)?;
    Ok(player::native_chrome_version())
}

#[tauri::command]
fn windows_native_playback_caps(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    require_player_or_catalog(&window, &state)?;
    Ok(player::native_playback_caps())
}

#[tauri::command]
fn windows_app_version(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    require_player_or_catalog(&window, &state)?;
    Ok(json!({
        "versionName": env!("CARGO_PKG_VERSION"),
        "versionCode": 0,
        "tv": false,
        "platform": "windows",
    }))
}

fn bridge_script() -> String {
    let bootstrap = json!({
        "chromeVersion": player::native_chrome_version(),
        "playbackCaps": player::native_playback_caps(),
        "appVersion": {
            "versionName": env!("CARGO_PKG_VERSION"),
            "versionCode": 0,
            "tv": false,
            "platform": "windows",
        }
    });
    format!(
        "Object.defineProperty(window,'__TRIBOON_WINDOWS_BOOTSTRAP__',{{value:Object.freeze({bootstrap}),configurable:false,writable:false}});\n{}",
        include_str!("../../ui/bridge.js")
    )
}

fn navigation_allowed(webview: &tauri::Webview, raw: &str) -> bool {
    if webview.label() == PLAYER_WINDOW_LABEL {
        return is_internal_app_url(raw);
    }
    if webview.label() != CONNECT_WINDOW_LABEL {
        return is_internal_app_url(raw);
    }
    if is_internal_app_url(raw) {
        return true;
    }
    let state = webview.app_handle().state::<AppState>();
    let Some(server) = state.server_origin() else {
        return false;
    };
    parse_http_url(raw)
        .map(|url| url.origin() == server)
        .unwrap_or(false)
}

fn main() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .manage(player::PlayerController::default())
        .setup(|app| {
            player::initialize_player_window(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(debug_assertions)]
            if let Some(server) = debug_smoke_server().map_err(std::io::Error::other)? {
                validate_server_reachable(&server).map_err(std::io::Error::other)?;
                app.state::<AppState>()
                    .set_server(Some(server.clone()))
                    .map_err(std::io::Error::other)?;
                let main = app
                    .get_webview_window(CONNECT_WINDOW_LABEL)
                    .ok_or_else(|| std::io::Error::other("main window is unavailable"))?;
                main.navigate(
                    server
                        .parse()
                        .map_err(|_| std::io::Error::other("invalid debug smoke URL"))?,
                )
                .map_err(std::io::Error::other)?;
            }
            if let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        if let Some(controller) = handle.try_state::<player::PlayerController>() {
                            controller.shutdown(&handle);
                        }
                        handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("triboon-navigation-guard")
                .on_navigation(|webview, url| navigation_allowed(webview, url.as_str()))
                .build(),
        )
        .on_page_load(|webview, payload| {
            if webview.label() != CONNECT_WINDOW_LABEL {
                return;
            }
            let app = webview.app_handle();
            let state = app.state::<AppState>();
            if is_internal_app_url(payload.url().as_str()) {
                state.remember_connect_url(payload.url().as_str());
                return;
            }
            let trusted = state
                .server_origin()
                .and_then(|server| {
                    parse_http_url(payload.url().as_str())
                        .ok()
                        .map(|url| url.origin() == server)
                })
                .unwrap_or(false);
            if trusted {
                // Started makes the synchronous bridge visible to Triboon's boot code.  Finished is
                // an idempotent retry for WebView2 versions that reject eval before document start.
                let _ = webview.eval(bridge_script());
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            windows_connect,
            last_server,
            windows_change_server,
            windows_native_chrome_version,
            windows_native_playback_caps,
            windows_app_version,
            player::windows_player_show_loading,
            player::windows_player_play_vod,
            player::windows_player_play_live,
            player::windows_player_control,
            player::windows_player_update,
            player::windows_player_open_guide,
            player::windows_player_close_guide,
            player::windows_player_set_guide_pip_rect,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Triboon for Windows");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(controller) = handle.try_state::<player::PlayerController>() {
                controller.shutdown(handle);
            }
            // Give the hidden catalog WebView a short opportunity to execute the final checkpoint.
            std::thread::sleep(Duration::from_millis(80));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_server_origins_without_paths() {
        assert_eq!(
            normalize_server(" HTTPS://Example.COM:8443/ ").unwrap(),
            "https://example.com:8443"
        );
        assert_eq!(
            normalize_server("http://127.0.0.1:7777").unwrap(),
            "http://127.0.0.1:7777"
        );
        assert!(normalize_server("https://example.com/app").is_err());
        assert!(normalize_server("file:///tmp/x").is_err());
        assert!(normalize_server("https://user:pass@example.com").is_err());
    }

    #[test]
    fn canonicalizes_default_ports() {
        assert_eq!(
            parse_http_url("https://EXAMPLE.com/path").unwrap().origin(),
            "https://example.com"
        );
        assert_eq!(
            parse_http_url("https://example.com:443/path")
                .unwrap()
                .origin(),
            "https://example.com"
        );
        assert_eq!(
            parse_http_url("http://example.com:80/path")
                .unwrap()
                .origin(),
            "http://example.com"
        );
        assert_eq!(
            parse_http_url("http://example.com:8080/path")
                .unwrap()
                .origin(),
            "http://example.com:8080"
        );
    }

    #[test]
    fn recognizes_only_a_triboon_server_document() {
        assert!(server_info_is_triboon(
            br#"{"version":"2.8.0","needsSetup":false}"#
        ));
        assert!(!server_info_is_triboon(br#"{"version":"2.8.0"}"#));
        assert!(!server_info_is_triboon(b"<html>hello</html>"));
    }

    #[test]
    fn internal_urls_are_narrow() {
        assert!(is_internal_app_url("http://tauri.localhost/connect.html"));
        assert!(is_internal_app_url("tauri://localhost/player.html"));
        assert!(!is_internal_app_url("about:blank"));
        assert!(!is_internal_app_url(
            "https://tauri.localhost.evil.test/player.html"
        ));
    }

    #[test]
    fn debug_smoke_server_allows_only_literal_loopback_http() {
        for allowed in ["http://127.0.0.1:17888", "http://[::1]:17888/"] {
            let parsed = parse_http_url(allowed).unwrap();
            assert_eq!(parsed.scheme, "http");
            assert!(parsed.host == "127.0.0.1" || parsed.host == "[::1]");
        }
        for rejected in [
            "https://127.0.0.1:17888",
            "http://localhost:17888",
            "http://192.168.1.20:17888",
            "http://127.0.0.1:17888/catalog",
        ] {
            let normalized = normalize_server(rejected);
            let accepted = normalized
                .ok()
                .and_then(|server| parse_http_url(&server).ok())
                .is_some_and(|parsed| {
                    parsed.scheme == "http"
                        && (parsed.host == "127.0.0.1" || parsed.host == "[::1]")
                });
            assert!(!accepted, "unexpectedly accepted {rejected}");
        }
    }
}
