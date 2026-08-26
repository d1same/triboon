//! In-app Windows installer updates.
//!
//! Only the official stable GitHub latest-download links are accepted. The downloaded
//! file must match SHA256SUMS.txt from the same release, then the installer UI opens.
//! Silent installs are never used.

use crate::{parse_http_url, CONNECT_WINDOW_LABEL};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const CLIENT_PATH: &str = "/d1same/triboon/releases/latest/download/Triboon-Windows-Client.exe";
const SERVER_PATH: &str = "/d1same/triboon/releases/latest/download/Triboon-Windows-Server.exe";
#[cfg(target_os = "windows")]
const SUMS_URL: &str = "https://github.com/d1same/triboon/releases/latest/download/SHA256SUMS.txt";
#[cfg(target_os = "windows")]
const MAX_UPDATE_BYTES: u64 = 250 * 1024 * 1024;
#[cfg(target_os = "windows")]
const MIN_UPDATE_BYTES: u64 = 1_000_000;

static UPDATE_LOCK: Mutex<bool> = Mutex::new(false);

pub(crate) fn allowed_windows_update_filename(raw: &str) -> Option<&'static str> {
    let parsed = parse_http_url(raw).ok()?;
    if parsed.scheme != "https" || parsed.host != "github.com" {
        return None;
    }
    match parsed.path_and_query.as_str() {
        CLIENT_PATH => Some("Triboon-Windows-Client.exe"),
        SERVER_PATH => Some("Triboon-Windows-Server.exe"),
        _ => None,
    }
}

pub(crate) fn sha256_for_file(text: &str, filename: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let hex = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").trim_start_matches('*');
        if name.eq_ignore_ascii_case(filename)
            && hex.len() == 64
            && hex.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Some(hex.to_ascii_lowercase());
        }
    }
    None
}

pub(crate) fn looks_like_pe(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == b'M' && bytes[1] == b'Z'
}

fn notify_catalog(app: &AppHandle, ok: bool, msg: &str) {
    let Ok(msg_json) = serde_json::to_string(msg) else {
        return;
    };
    let script = format!(
        "try{{window.__triboonWindowsUpdateResult&&window.__triboonWindowsUpdateResult({},{})}}catch(e){{}}",
        if ok { "true" } else { "false" },
        msg_json
    );
    if let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) {
        let _ = main.eval(script);
    }
}

fn begin_update() -> Result<(), String> {
    let mut busy = UPDATE_LOCK
        .lock()
        .map_err(|_| "update lock is unavailable".to_string())?;
    if *busy {
        return Err("Update is already downloading".into());
    }
    *busy = true;
    Ok(())
}

fn end_update() {
    if let Ok(mut busy) = UPDATE_LOCK.lock() {
        *busy = false;
    }
}

pub(crate) fn start_windows_update(app: AppHandle, url: String, filename: &'static str) -> Result<(), String> {
    begin_update()?;
    std::thread::Builder::new()
        .name("triboon-win-update".into())
        .spawn(move || {
            let result = run_windows_update(&url, filename);
            match result {
                Ok(()) => notify_catalog(&app, true, "Installer opened"),
                Err(err) => notify_catalog(&app, false, &err),
            }
            end_update();
        })
        .map_err(|e| {
            end_update();
            e.to_string()
        })?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn run_windows_update(_url: &str, _filename: &str) -> Result<(), String> {
    Err("Windows updates are only available on Windows".into())
}

#[cfg(target_os = "windows")]
fn run_windows_update(url: &str, filename: &str) -> Result<(), String> {
    use std::fs;
    let dest = update_path(filename)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let sums = download_text(SUMS_URL)?;
    let expected = sha256_for_file(&sums, filename)
        .ok_or_else(|| "release checksum is missing".to_string())?;
    download_file(url, &dest)?;
    verify_installer(&dest, &expected)?;
    launch_installer(&dest)
}

#[cfg(target_os = "windows")]
fn update_path(filename: &str) -> Result<std::path::PathBuf, String> {
    Ok(std::env::temp_dir().join("triboon-update").join(filename))
}

#[cfg(target_os = "windows")]
fn hidden_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(target_os = "windows")]
fn download_file(url: &str, dest: &std::path::Path) -> Result<(), String> {
    use std::fs;
    let _ = fs::remove_file(dest);
    let status = hidden_command("curl.exe")
        .args([
            "-fL",
            "--max-filesize",
            &MAX_UPDATE_BYTES.to_string(),
            "-o",
        ])
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|e| format!("download failed: {e}"))?;
    if !status.success() {
        let _ = fs::remove_file(dest);
        return Err("download failed".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn download_text(url: &str) -> Result<String, String> {
    use std::fs;
    let dest = std::env::temp_dir().join("triboon-update").join("SHA256SUMS.txt");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    download_file(url, &dest)?;
    let text = fs::read_to_string(&dest).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(dest);
    Ok(text)
}

#[cfg(target_os = "windows")]
fn file_sha256_hex(path: &std::path::Path) -> Result<String, String> {
    let out = hidden_command("certutil")
        .args(["-hashfile"])
        .arg(path)
        .arg("SHA256")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("could not hash the downloaded installer".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let hex: String = line.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        if hex.len() == 64 {
            return Ok(hex.to_ascii_lowercase());
        }
    }
    Err("could not hash the downloaded installer".into())
}

#[cfg(target_os = "windows")]
fn verify_installer(path: &std::path::Path, expected: &str) -> Result<(), String> {
    use std::fs;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() < MIN_UPDATE_BYTES || meta.len() > MAX_UPDATE_BYTES {
        let _ = fs::remove_file(path);
        return Err("downloaded installer has the wrong size".into());
    }
    let mut header = [0u8; 2];
    fs::File::open(path)
        .and_then(|mut f| {
            use std::io::Read;
            f.read_exact(&mut header)
        })
        .map_err(|e| e.to_string())?;
    if !looks_like_pe(&header) {
        let _ = fs::remove_file(path);
        return Err("downloaded file is not a Windows installer".into());
    }
    let actual = file_sha256_hex(path)?;
    if actual != expected {
        let _ = fs::remove_file(path);
        return Err("downloaded installer failed the checksum".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open the installer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_official_stable_windows_installers() {
        assert_eq!(
            allowed_windows_update_filename(
                "https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Client.exe"
            ),
            Some("Triboon-Windows-Client.exe")
        );
        assert_eq!(
            allowed_windows_update_filename(
                "https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Server.exe"
            ),
            Some("Triboon-Windows-Server.exe")
        );
        assert!(allowed_windows_update_filename(
            "https://github.com/d1same/triboon/releases/latest/download/triboon.apk"
        )
        .is_none());
        assert!(allowed_windows_update_filename(
            "https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Client-v3.1.10.exe"
        )
        .is_none());
        assert!(allowed_windows_update_filename(
            "https://evil.example/Triboon-Windows-Client.exe"
        )
        .is_none());
        assert!(allowed_windows_update_filename(
            "http://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Client.exe"
        )
        .is_none());
    }

    #[test]
    fn reads_sha256sums_for_the_requested_file() {
        let text = "\
aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999  Triboon-Windows-Client.exe
111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000 *Triboon-Windows-Server.exe
";
        assert_eq!(
            sha256_for_file(text, "Triboon-Windows-Client.exe").as_deref(),
            Some("aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999")
        );
        assert_eq!(
            sha256_for_file(text, "Triboon-Windows-Server.exe").as_deref(),
            Some("111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000")
        );
        assert!(sha256_for_file(text, "triboon.apk").is_none());
    }

    #[test]
    fn pe_magic_is_mz() {
        assert!(looks_like_pe(b"MZ\0\0"));
        assert!(!looks_like_pe(b"PK\0\0"));
        assert!(!looks_like_pe(b"M"));
    }
}
