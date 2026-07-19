//! Native Windows playback.
//!
//! libmpv is created and touched by exactly one actor thread.  Tauri commands validate their
//! caller and payload, then send typed messages to that actor.  The persistent `player` window is
//! reused for source changes and episode handoffs; `main` is revealed only for an explicit close.

use crate::{
    parse_http_url, require_catalog_origin, require_player_or_catalog, AppState, HttpUrl,
    CONNECT_WINDOW_LABEL, PLAYER_WINDOW_LABEL,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAX_TEXT: usize = 512;
const MAX_URL: usize = 8192;
const MAX_CHOICES: usize = 250;
const MAX_PLAYBACK_SECONDS: f64 = 14.0 * 24.0 * 60.0 * 60.0;
const VOD_STARTUP_TIMEOUT: Duration = Duration::from_secs(28);
const VOD_REBUFFER_TIMEOUT: Duration = Duration::from_secs(32);
const LIVE_STARTUP_TIMEOUT: Duration = Duration::from_secs(9);
const LIVE_REBUFFER_TIMEOUT: Duration = Duration::from_secs(14);

pub(crate) fn native_chrome_version() -> u32 {
    if cfg!(all(feature = "player", target_os = "windows")) {
        4
    } else {
        0
    }
}

pub(crate) fn native_playback_caps() -> Value {
    json!({
        "available": native_chrome_version() > 0,
        "player": "libmpv",
        "videoOutput": "gpu-next",
        "gpuApi": "d3d11",
        "hwdecRequested": "auto-safe",
        "hwdecMeasured": true,
        "softwareFallback": true,
        "hdr": "display-capability-dependent",
        "audioPassthrough": false,
        "nativeLive": true,
        "subtitles": true,
        "episodeHandoff": true,
        "progressIntervalMs": 1000,
        "statsIntervalMs": 2000
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadingPayload {
    #[serde(default = "default_title")]
    title: String,
    #[serde(default)]
    backdrop_url: String,
    #[serde(default)]
    playback_token: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaChoice {
    #[serde(default)]
    url: String,
    #[serde(default)]
    mime: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodPayload {
    #[serde(default = "default_title")]
    title: String,
    #[serde(default)]
    episode_label: String,
    #[serde(default)]
    source: String,
    url: String,
    #[serde(default)]
    backdrop_url: String,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    start_offset: f64,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    quality_label: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    start_fraction: f64,
    #[serde(default)]
    buffer_goal_sec: u32,
    #[serde(default)]
    playback_token: u64,
    #[serde(default)]
    quality_choices: bool,
    #[serde(default)]
    has_next: bool,
    #[serde(default)]
    subtitle_rel: String,
    #[serde(default)]
    subtitle_url: String,
    #[serde(default)]
    subtitle_lang: String,
    #[serde(default)]
    subtitle_label: String,
    #[serde(default)]
    subtitle_shift: f64,
    #[serde(default)]
    subtitle_size: String,
    #[serde(default)]
    subtitle_choices: Vec<Value>,
    #[serde(default)]
    episode_choices: Vec<Value>,
    #[serde(default)]
    quiet_seek: bool,
    #[serde(default)]
    percent_resume: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePayload {
    #[serde(default = "default_live_title")]
    title: String,
    #[serde(default)]
    source: String,
    url: String,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    fallback_url: String,
    #[serde(default)]
    fallback_mime: String,
    #[serde(default)]
    fallbacks: Vec<MediaChoice>,
    #[serde(default)]
    guide: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ActiveSubtitlePayload {
    #[serde(default)]
    subtitle_rel: String,
    #[serde(default)]
    subtitle_url: String,
    #[serde(default)]
    subtitle_lang: String,
    #[serde(default)]
    subtitle_label: String,
    #[serde(default)]
    subtitle_shift: f64,
    #[serde(default)]
    subtitle_size: String,
    #[serde(default)]
    subtitle_startup: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn default_title() -> String {
    "Triboon".into()
}

fn default_live_title() -> String {
    "Live TV".into()
}

fn default_kind() -> String {
    "direct".into()
}

fn validate_text(value: &str, field: &str, max: usize) -> Result<(), String> {
    if value.len() > max || value.chars().any(|c| c == '\0') {
        return Err(format!("{field} is too long or invalid"));
    }
    Ok(())
}

fn finite_seconds(value: f64, field: &str) -> Result<f64, String> {
    if !value.is_finite() || !(0.0..=MAX_PLAYBACK_SECONDS).contains(&value) {
        return Err(format!("{field} is outside the supported range"));
    }
    Ok(value)
}

fn redact_url_query(message: &str) -> String {
    let mut safe = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(start) = [rest.find("http://"), rest.find("https://")]
        .into_iter()
        .flatten()
        .min()
    {
        safe.push_str(&rest[..start]);
        let candidate = &rest[start..];
        let end = candidate
            .char_indices()
            .find_map(|(index, ch)| {
                (index > 0 && (ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | '`')))
                    .then_some(index)
            })
            .unwrap_or(candidate.len());
        let url = &candidate[..end];
        if let Some(query) = url.find('?') {
            safe.push_str(&url[..query]);
            safe.push_str("?[redacted]");
        } else {
            safe.push_str(url);
        }
        rest = &candidate[end..];
    }
    safe.push_str(rest);
    safe
}

fn url_path(url: &HttpUrl) -> &str {
    url.path_and_query
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(url.path_and_query.as_str())
}

fn vod_path_allowed(path: &str) -> bool {
    [
        "/api/stream/",
        "/api/remux/",
        "/api/transcode/",
        "/api/hls/",
        "/api/local/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

fn subtitle_path_allowed(path: &str) -> bool {
    ["/api/subtitle/", "/api/releasesub/", "/api/ossubs/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

fn live_server_path_allowed(path: &str) -> bool {
    [
        "/api/iptv/",
        "/api/stream/",
        "/api/remux/",
        "/api/transcode/",
        "/api/hls/",
        "/api/local/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

fn ipv4_bytes_forbidden(octets: [u8; 4]) -> bool {
    let first = octets[0];
    let second = octets[1];
    first == 0
        || first == 10
        || first == 127
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && matches!(second, 0 | 168))
        || (first == 198 && matches!(second, 18 | 19))
        || first >= 224
}

fn external_ip_forbidden(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => ipv4_bytes_forbidden(ip.octets()),
        IpAddr::V6(ip) => {
            let bytes = ip.octets();
            let first = ip.segments()[0];
            if ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80
                || first & 0xffc0 == 0xfec0
                || first == 0x2002
                || (first == 0x2001 && ip.segments()[1] == 0)
            {
                return true;
            }

            let mapped =
                bytes[..10].iter().all(|byte| *byte == 0) && bytes[10] == 0xff && bytes[11] == 0xff;
            let compatible = bytes[..12].iter().all(|byte| *byte == 0);
            let nat64 = bytes[..4] == [0x00, 0x64, 0xff, 0x9b];
            (mapped || compatible || nat64)
                && ipv4_bytes_forbidden([bytes[12], bytes[13], bytes[14], bytes[15]])
        }
    }
}

fn external_host_forbidden(host: &str) -> bool {
    let clean = host.trim_matches(['[', ']']).to_ascii_lowercase();
    clean == "localhost"
        || clean.ends_with(".localhost")
        || clean.ends_with(".local")
        || clean == "metadata.google.internal"
        || clean
            .parse::<IpAddr>()
            .map(external_ip_forbidden)
            .unwrap_or(false)
}

fn artwork_host_forbidden(host: &str) -> bool {
    external_host_forbidden(host)
}

fn validated_same_origin_url(
    raw: &str,
    server: &str,
    allowed_path: fn(&str) -> bool,
    field: &str,
) -> Result<String, String> {
    if raw.is_empty() || raw.len() > MAX_URL {
        return Err(format!("{field} URL is missing or too long"));
    }
    let parsed = parse_http_url(raw).map_err(|_| format!("{field} URL is invalid"))?;
    if parsed.origin() != server || !allowed_path(url_path(&parsed)) {
        return Err(format!(
            "{field} URL is outside the configured Triboon server routes"
        ));
    }
    Ok(parsed.normalized_url())
}

fn validated_optional_artwork(raw: &str, server: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.len() > MAX_URL {
        return Err("artwork URL is too long".into());
    }
    let parsed = parse_http_url(raw).map_err(|_| "artwork URL is invalid".to_string())?;
    if parsed.origin() != server && artwork_host_forbidden(&parsed.host) {
        return Err("artwork URL targets a protected local address".into());
    }
    Ok(parsed.normalized_url())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidatedLiveUrl {
    connect_url: String,
    host_header: String,
}

fn host_header_for(url: &HttpUrl) -> String {
    let default_port =
        (url.scheme == "http" && url.port == 80) || (url.scheme == "https" && url.port == 443);
    if default_port {
        url.host.clone()
    } else {
        format!("{}:{}", url.host, url.port)
    }
}

fn pinned_url(url: &HttpUrl, address: IpAddr) -> String {
    let host = match address {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let default_port =
        (url.scheme == "http" && url.port == 80) || (url.scheme == "https" && url.port == 443);
    let authority = if default_port {
        host
    } else {
        format!("{host}:{}", url.port)
    };
    format!("{}://{}{}", url.scheme, authority, url.path_and_query)
}

fn validated_live_url_with_resolver<F>(
    raw: &str,
    server: &str,
    field: &str,
    resolver: F,
) -> Result<ValidatedLiveUrl, String>
where
    F: FnOnce(&str, u16) -> Result<Vec<IpAddr>, String>,
{
    if raw.is_empty() || raw.len() > MAX_URL {
        return Err(format!("{field} URL is missing or too long"));
    }
    let parsed = parse_http_url(raw).map_err(|_| format!("{field} URL is invalid"))?;
    if parsed.origin() == server {
        if !live_server_path_allowed(url_path(&parsed)) {
            return Err(format!("{field} uses an unsupported Triboon route"));
        }
        return Ok(ValidatedLiveUrl {
            connect_url: parsed.normalized_url(),
            host_header: String::new(),
        });
    }

    if external_host_forbidden(&parsed.host) {
        return Err(format!("{field} targets a protected local address"));
    }
    let clean_host = parsed.host.trim_matches(['[', ']']);
    let literal = clean_host.parse::<IpAddr>().ok();
    if parsed.scheme == "https" && literal.is_none() {
        return Err(format!(
            "{field} HTTPS host cannot preserve certificate identity after DNS pinning"
        ));
    }
    let addresses = match literal {
        Some(address) => vec![address],
        None => resolver(clean_host, parsed.port)
            .map_err(|_| format!("{field} host could not be resolved"))?,
    };
    if addresses.is_empty() {
        return Err(format!("{field} host could not be resolved"));
    }
    if addresses.iter().copied().any(external_ip_forbidden) {
        return Err(format!("{field} targets a protected local address"));
    }
    let host_header = host_header_for(&parsed);
    if host_header.is_empty()
        || host_header
            .chars()
            .any(|character| character.is_control() || character == ',')
    {
        return Err(format!("{field} host is invalid"));
    }
    Ok(ValidatedLiveUrl {
        connect_url: pinned_url(&parsed, addresses[0]),
        host_header,
    })
}

fn validated_live_url(raw: &str, server: &str, field: &str) -> Result<ValidatedLiveUrl, String> {
    validated_live_url_with_resolver(raw, server, field, |host, port| {
        (host, port)
            .to_socket_addrs()
            .map(|addresses| addresses.map(|address| address.ip()).collect())
            .map_err(|_| "host resolution failed".to_string())
    })
}

#[derive(Debug, Clone)]
struct SubtitleRequest {
    rel: String,
    url: String,
    lang: String,
    label: String,
    shift: f64,
    size: String,
    startup: bool,
}

#[derive(Debug, Clone)]
struct VodRequest {
    title: String,
    episode_label: String,
    source: String,
    url: String,
    backdrop_url: String,
    start: f64,
    start_offset: f64,
    kind: String,
    quality_label: String,
    size: u64,
    duration: f64,
    start_fraction: f64,
    buffer_goal_sec: u32,
    token: u64,
    quality_choices: bool,
    has_next: bool,
    subtitle: SubtitleRequest,
    subtitle_choices: Vec<Value>,
    episode_choices: Vec<Value>,
    quiet_seek: bool,
    percent_resume: bool,
}

#[derive(Debug, Clone)]
struct PlaybackCandidate {
    url: String,
    host_header: String,
}

#[derive(Debug, Clone)]
struct LiveRequest {
    title: String,
    source: String,
    candidates: Vec<PlaybackCandidate>,
    guide: bool,
}

fn validate_vod(payload: VodPayload, server: &str) -> Result<VodRequest, String> {
    for (field, value) in [
        ("title", payload.title.as_str()),
        ("episode label", payload.episode_label.as_str()),
        ("source", payload.source.as_str()),
        ("quality label", payload.quality_label.as_str()),
        ("subtitle label", payload.subtitle_label.as_str()),
    ] {
        validate_text(value, field, MAX_TEXT)?;
    }
    validate_text(&payload.mime, "media MIME type", 128)?;
    let kind = payload.kind.to_ascii_lowercase();
    if !matches!(kind.as_str(), "direct" | "remux" | "transcode") {
        return Err("unsupported playback path".into());
    }
    if payload.subtitle_choices.len() > MAX_CHOICES || payload.episode_choices.len() > MAX_CHOICES {
        return Err("player choices exceed the supported limit".into());
    }
    let url = validated_same_origin_url(&payload.url, server, vod_path_allowed, "video")?;
    let subtitle_url = if payload.subtitle_url.is_empty() {
        String::new()
    } else {
        validated_same_origin_url(
            &payload.subtitle_url,
            server,
            subtitle_path_allowed,
            "subtitle",
        )?
    };
    if !payload.subtitle_shift.is_finite() || payload.subtitle_shift.abs() > 600.0 {
        return Err("subtitle shift is outside the supported range".into());
    }
    if !payload.start_fraction.is_finite() || !(0.0..=0.96).contains(&payload.start_fraction) {
        return Err("resume percentage is outside the supported range".into());
    }
    Ok(VodRequest {
        title: payload.title,
        episode_label: payload.episode_label,
        source: payload.source,
        url,
        backdrop_url: validated_optional_artwork(&payload.backdrop_url, server)?,
        start: finite_seconds(payload.start, "start position")?,
        start_offset: finite_seconds(payload.start_offset, "stream offset")?,
        kind,
        quality_label: payload.quality_label,
        size: payload.size,
        duration: finite_seconds(payload.duration, "duration")?,
        start_fraction: payload.start_fraction,
        buffer_goal_sec: payload.buffer_goal_sec.min(300),
        token: payload.playback_token,
        quality_choices: payload.quality_choices,
        has_next: payload.has_next,
        subtitle: SubtitleRequest {
            rel: payload.subtitle_rel.chars().take(256).collect(),
            url: subtitle_url,
            lang: payload.subtitle_lang.chars().take(32).collect(),
            label: payload.subtitle_label,
            shift: payload.subtitle_shift,
            size: payload.subtitle_size.chars().take(16).collect(),
            startup: true,
        },
        subtitle_choices: payload.subtitle_choices,
        episode_choices: payload.episode_choices,
        quiet_seek: payload.quiet_seek,
        percent_resume: payload.percent_resume,
    })
}

fn validate_live(payload: LivePayload, server: &str) -> Result<LiveRequest, String> {
    validate_text(&payload.title, "title", MAX_TEXT)?;
    validate_text(&payload.source, "source", MAX_TEXT)?;
    if payload.fallbacks.len() > 8 {
        return Err("too many live fallbacks".into());
    }
    let mut raw_candidates = vec![(payload.url, payload.mime, "live stream".to_string())];
    if !payload.fallback_url.is_empty() {
        raw_candidates.push((
            payload.fallback_url,
            payload.fallback_mime,
            "live fallback".to_string(),
        ));
    }
    raw_candidates.extend(
        payload
            .fallbacks
            .into_iter()
            .enumerate()
            .map(|(index, candidate)| {
                (
                    candidate.url,
                    candidate.mime,
                    format!("live fallback {index}"),
                )
            }),
    );
    let mut candidates = Vec::new();
    for (raw, _mime, label) in raw_candidates {
        // A provider-native URL can use syntax the security boundary deliberately rejects (for
        // example URL userinfo). Keep walking so the safe same-origin server-remux fallback can
        // still play instead of failing the whole channel request.
        let Ok(validated) = validated_live_url(&raw, server, &label) else {
            continue;
        };
        if !candidates.iter().any(|known: &PlaybackCandidate| {
            known.url == validated.connect_url && known.host_header == validated.host_header
        }) {
            candidates.push(PlaybackCandidate {
                url: validated.connect_url,
                host_header: validated.host_header,
            });
        }
    }
    if candidates.is_empty() {
        return Err("no safe Live TV candidate is available".into());
    }
    Ok(LiveRequest {
        title: payload.title,
        source: payload.source,
        candidates,
        guide: payload.guide,
    })
}

#[derive(Debug, Clone)]
enum ControlAction {
    Play,
    Pause,
    Toggle,
    Close,
    SeekAbsolute(f64),
    SeekRelative(f64),
    Next,
    Quality(String),
    Episode(usize),
    Subtitle(SubtitleRequest),
    SubtitleShowAll,
    SubtitleVersions(String),
    SubtitleShift(f64),
    Audio(String),
    Volume(f64),
    Mute(bool),
    Retry,
    ToggleFullscreen,
    Minimize,
    LiveFavoriteToggle,
    LiveZap(i32),
    RequestState,
    OpenGuide,
    CloseGuide,
}

fn number_from_payload(payload: &Value, names: &[&str]) -> Option<f64> {
    if let Some(number) = payload.as_f64() {
        return Some(number);
    }
    names
        .iter()
        .find_map(|name| payload.get(*name).and_then(Value::as_f64))
}

fn string_from_payload(payload: &Value, names: &[&str]) -> Option<String> {
    fn value_as_string(value: &Value) -> Option<String> {
        if let Some(text) = value.as_str() {
            return Some(text.to_string());
        }
        if let Some(number) = value.as_i64() {
            return Some(number.to_string());
        }
        value.as_u64().map(|number| number.to_string())
    }
    if let Some(value) = value_as_string(payload) {
        return Some(value);
    }
    names
        .iter()
        .find_map(|name| payload.get(*name).and_then(value_as_string))
}

fn parse_control(
    action: &str,
    payload: Value,
    server: Option<&str>,
) -> Result<ControlAction, String> {
    match action.trim().to_ascii_lowercase().as_str() {
        "play" | "resume" => Ok(ControlAction::Play),
        "pause" => Ok(ControlAction::Pause),
        "toggle" | "play_pause" => Ok(ControlAction::Toggle),
        "stop" | "close" | "back" => Ok(ControlAction::Close),
        "seek" | "seek_absolute" => {
            let value = number_from_payload(&payload, &["seconds", "position", "value"])
                .ok_or_else(|| "seek position is missing".to_string())?;
            Ok(ControlAction::SeekAbsolute(finite_seconds(
                value,
                "seek position",
            )?))
        }
        "seek_relative" | "skip" => {
            let value = number_from_payload(&payload, &["seconds", "delta", "value"])
                .ok_or_else(|| "seek delta is missing".to_string())?;
            if !value.is_finite() || value.abs() > 3600.0 {
                return Err("seek delta is outside the supported range".into());
            }
            Ok(ControlAction::SeekRelative(value))
        }
        "next" => Ok(ControlAction::Next),
        "quality" => Ok(ControlAction::Quality(
            string_from_payload(&payload, &["quality", "value"])
                .unwrap_or_else(|| "orig".into())
                .chars()
                .take(32)
                .collect(),
        )),
        "episode" | "episode_select" => {
            let index = number_from_payload(&payload, &["index", "value"])
                .ok_or_else(|| "episode index is missing".to_string())?;
            if !index.is_finite() || index < 0.0 || index > MAX_CHOICES as f64 {
                return Err("episode index is invalid".into());
            }
            Ok(ControlAction::Episode(index as usize))
        }
        "subtitle" | "subtitle_select" => {
            let rel = string_from_payload(&payload, &["rel", "value"])
                .unwrap_or_default()
                .chars()
                .take(256)
                .collect::<String>();
            let raw_url = payload
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let url = if raw_url.is_empty() {
                String::new()
            } else {
                validated_same_origin_url(
                    raw_url,
                    server.ok_or_else(|| "no server configured".to_string())?,
                    subtitle_path_allowed,
                    "subtitle",
                )?
            };
            let shift = number_from_payload(&payload, &["shift", "subtitleShift"]).unwrap_or(0.0);
            if !shift.is_finite() || shift.abs() > 600.0 {
                return Err("subtitle shift is outside the supported range".into());
            }
            Ok(ControlAction::Subtitle(SubtitleRequest {
                rel,
                url,
                lang: string_from_payload(&payload, &["lang", "subtitleLang"])
                    .unwrap_or_default()
                    .chars()
                    .take(32)
                    .collect(),
                label: string_from_payload(&payload, &["label", "subtitleLabel"])
                    .unwrap_or_else(|| "Triboon subtitles".into())
                    .chars()
                    .take(MAX_TEXT)
                    .collect(),
                shift,
                size: string_from_payload(&payload, &["size", "subtitleSize"])
                    .unwrap_or_else(|| "M".into())
                    .chars()
                    .take(16)
                    .collect(),
                startup: false,
            }))
        }
        "subtitle_show_all" => Ok(ControlAction::SubtitleShowAll),
        "subtitle_versions" => Ok(ControlAction::SubtitleVersions(
            string_from_payload(&payload, &["lang", "value"])
                .unwrap_or_else(|| "en".into())
                .chars()
                .take(16)
                .collect(),
        )),
        "subtitle_shift" => {
            let value = number_from_payload(&payload, &["shift", "value"])
                .ok_or_else(|| "subtitle shift is missing".to_string())?;
            if !value.is_finite() || value.abs() > 600.0 {
                return Err("subtitle shift is outside the supported range".into());
            }
            Ok(ControlAction::SubtitleShift(value))
        }
        "audio" | "audio_select" => Ok(ControlAction::Audio(
            string_from_payload(&payload, &["id", "value"])
                .unwrap_or_default()
                .chars()
                .take(32)
                .collect(),
        )),
        "volume" => {
            let value = number_from_payload(&payload, &["volume", "value"])
                .ok_or_else(|| "volume is missing".to_string())?;
            if !value.is_finite() || !(0.0..=100.0).contains(&value) {
                return Err("volume is outside the supported range".into());
            }
            Ok(ControlAction::Volume(value))
        }
        "mute" => Ok(ControlAction::Mute(
            payload
                .as_bool()
                .or_else(|| payload.get("muted").and_then(Value::as_bool))
                .unwrap_or(true),
        )),
        "retry" => Ok(ControlAction::Retry),
        "fullscreen" | "toggle_fullscreen" => Ok(ControlAction::ToggleFullscreen),
        "minimize" => Ok(ControlAction::Minimize),
        "favorite" | "live_favorite_toggle" => Ok(ControlAction::LiveFavoriteToggle),
        "live_zap" => {
            let direction = number_from_payload(&payload, &["direction", "value"]).unwrap_or(1.0);
            Ok(ControlAction::LiveZap(if direction < 0.0 { -1 } else { 1 }))
        }
        "request_state" => Ok(ControlAction::RequestState),
        "open_guide" => Ok(ControlAction::OpenGuide),
        "close_guide" => Ok(ControlAction::CloseGuide),
        _ => Err("unknown player action".into()),
    }
}

#[derive(Debug, Clone)]
enum UpdateAction {
    SubtitleChoices(Vec<Value>),
    ActiveSubtitle(SubtitleRequest),
    Duration(f64),
    EpisodeChoices {
        choices: Vec<Value>,
        focus_index: usize,
    },
    UpNext(Value),
    UpNextHide,
    LiveEpg(Vec<Value>),
    LiveFavorite(bool),
}

fn value_choices(payload: Value, key: &str) -> Result<Vec<Value>, String> {
    let array = if let Some(value) = payload.get(key) {
        value.as_array().cloned()
    } else {
        payload.as_array().cloned()
    }
    .ok_or_else(|| format!("{key} must be an array"))?;
    if array.len() > MAX_CHOICES {
        return Err(format!("too many {key}"));
    }
    Ok(array)
}

fn parse_update(kind: &str, payload: Value, server: &str) -> Result<UpdateAction, String> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "subtitle_choices" => Ok(UpdateAction::SubtitleChoices(value_choices(
            payload, "choices",
        )?)),
        "active_subtitle" => {
            let parsed: ActiveSubtitlePayload = serde_json::from_value(payload)
                .map_err(|_| "invalid subtitle update".to_string())?;
            let url = if parsed.subtitle_url.is_empty() {
                String::new()
            } else {
                validated_same_origin_url(
                    &parsed.subtitle_url,
                    server,
                    subtitle_path_allowed,
                    "subtitle",
                )?
            };
            if !parsed.subtitle_shift.is_finite() || parsed.subtitle_shift.abs() > 600.0 {
                return Err("subtitle shift is outside the supported range".into());
            }
            Ok(UpdateAction::ActiveSubtitle(SubtitleRequest {
                rel: parsed.subtitle_rel.chars().take(256).collect(),
                url,
                lang: parsed.subtitle_lang.chars().take(32).collect(),
                label: parsed.subtitle_label.chars().take(MAX_TEXT).collect(),
                shift: parsed.subtitle_shift,
                size: parsed.subtitle_size.chars().take(16).collect(),
                startup: parsed.subtitle_startup,
            }))
        }
        "duration" => {
            let duration = number_from_payload(&payload, &["duration", "seconds", "value"])
                .or_else(|| payload.as_str().and_then(|s| s.parse::<f64>().ok()))
                .ok_or_else(|| "duration is missing".to_string())?;
            Ok(UpdateAction::Duration(finite_seconds(
                duration, "duration",
            )?))
        }
        "episode_choices" => {
            let focus_index = payload
                .get("focusIndex")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(MAX_CHOICES as u64) as usize;
            Ok(UpdateAction::EpisodeChoices {
                choices: value_choices(payload, "episodes")?,
                focus_index,
            })
        }
        "up_next" => Ok(UpdateAction::UpNext(payload)),
        "up_next_hide" => Ok(UpdateAction::UpNextHide),
        "live_epg" => Ok(UpdateAction::LiveEpg(value_choices(payload, "programs")?)),
        "live_favorite" => Ok(UpdateAction::LiveFavorite(
            payload
                .as_bool()
                .or_else(|| payload.get("on").and_then(Value::as_bool))
                .unwrap_or(false),
        )),
        _ => Err("unknown player update".into()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerUiState {
    #[serde(rename = "type")]
    event_type: String,
    token: u64,
    title: String,
    episode_label: String,
    source: String,
    backdrop_url: String,
    is_live: bool,
    playing: bool,
    paused: bool,
    buffering: bool,
    pos: f64,
    duration: f64,
    buffered: f64,
    volume: f64,
    muted: bool,
    quality_label: String,
    source_size: u64,
    subtitle_rel: String,
    subtitle_label: String,
    audio_tracks: Vec<Value>,
    audio_id: String,
    audio_label: String,
    hwdec: String,
    hwdec_active: bool,
    video_codec: String,
    audio_codec: String,
    width: i64,
    height: i64,
    fps: f64,
    dropped_frames: i64,
    bitrate: i64,
    subtitle_choices: Vec<Value>,
    episode_choices: Vec<Value>,
    episode_focus_index: usize,
    up_next: Value,
    live_epg: Vec<Value>,
    live_favorite: bool,
    guide: bool,
    has_next: bool,
    has_quality_choices: bool,
    message: String,
}

impl Default for PlayerUiState {
    fn default() -> Self {
        Self {
            event_type: "idle".into(),
            token: 0,
            title: "Triboon".into(),
            episode_label: String::new(),
            source: String::new(),
            backdrop_url: String::new(),
            is_live: false,
            playing: false,
            paused: false,
            buffering: false,
            pos: 0.0,
            duration: 0.0,
            buffered: 0.0,
            volume: 100.0,
            muted: false,
            quality_label: String::new(),
            source_size: 0,
            subtitle_rel: String::new(),
            subtitle_label: String::new(),
            audio_tracks: Vec::new(),
            audio_id: String::new(),
            audio_label: String::new(),
            hwdec: String::new(),
            hwdec_active: false,
            video_codec: String::new(),
            audio_codec: String::new(),
            width: 0,
            height: 0,
            fps: 0.0,
            dropped_frames: 0,
            bitrate: 0,
            subtitle_choices: Vec::new(),
            episode_choices: Vec::new(),
            episode_focus_index: 0,
            up_next: Value::Null,
            live_epg: Vec::new(),
            live_favorite: false,
            guide: false,
            has_next: false,
            has_quality_choices: false,
            message: String::new(),
        }
    }
}

impl PlayerUiState {
    fn loading(payload: &LoadingPayload) -> Self {
        Self {
            event_type: "loading".into(),
            token: payload.playback_token,
            title: payload.title.clone(),
            backdrop_url: payload.backdrop_url.clone(),
            buffering: true,
            ..Self::default()
        }
    }
}

#[derive(Debug)]
enum PlayerCommand {
    ShowLoading(PlayerUiState),
    PlayVod(VodRequest),
    PlayLive(LiveRequest),
    Control(ControlAction),
    Update(UpdateAction),
    Close { notify: bool },
    Shutdown,
}

struct ActorHandle {
    tx: Sender<PlayerCommand>,
}

pub(crate) struct PlayerController {
    actor: Mutex<Option<ActorHandle>>,
    last_ui: Arc<Mutex<PlayerUiState>>,
}

impl Default for PlayerController {
    fn default() -> Self {
        Self {
            actor: Mutex::new(None),
            last_ui: Arc::new(Mutex::new(PlayerUiState::default())),
        }
    }
}

impl PlayerController {
    fn publish_ui(&self, app: &tauri::AppHandle, state: PlayerUiState) {
        publish_ui(app, &self.last_ui, state);
    }

    fn enter_loading(&self, app: &tauri::AppHandle, state: PlayerUiState) -> Result<(), String> {
        let mut actor = match self.actor.lock() {
            Ok(actor) => actor,
            Err(_) => {
                self.publish_ui(app, state);
                return Err("native player state is unavailable".into());
            }
        };
        if let Some(handle) = actor.as_ref() {
            if handle
                .tx
                .send(PlayerCommand::ShowLoading(state.clone()))
                .is_ok()
            {
                return Ok(());
            }
            *actor = None;
        }
        drop(actor);
        self.publish_ui(app, state);
        Ok(())
    }

    fn send(
        &self,
        app: &tauri::AppHandle,
        command: PlayerCommand,
        start_if_needed: bool,
    ) -> Result<(), String> {
        let mut actor = self
            .actor
            .lock()
            .map_err(|_| "native player state is unavailable".to_string())?;
        let command = if let Some(handle) = actor.as_ref() {
            match handle.tx.send(command) {
                Ok(()) => return Ok(()),
                Err(disconnected) => {
                    *actor = None;
                    disconnected.0
                }
            }
        } else {
            command
        };
        if actor.is_none() && start_if_needed {
            let window = ensure_player_window(app)?;
            let surface = player_surface_id(&window)?;
            let (tx, rx) = mpsc::channel();
            let thread_tx = tx.clone();
            let app_handle = app.clone();
            let last_ui = Arc::clone(&self.last_ui);
            thread::Builder::new()
                .name("triboon-libmpv".into())
                .spawn(move || actor_loop(app_handle, surface, rx, last_ui))
                .map_err(|e| format!("could not start native player: {e}"))?;
            *actor = Some(ActorHandle { tx: thread_tx });
        }
        let Some(handle) = actor.as_ref() else {
            return Err("native player is not active".into());
        };
        handle.tx.send(command).map_err(|_| {
            *actor = None;
            "native player stopped unexpectedly".to_string()
        })
    }

    pub(crate) fn close(&self, app: &tauri::AppHandle, notify: bool) -> Result<(), String> {
        if self
            .send(app, PlayerCommand::Close { notify }, false)
            .is_err()
        {
            close_without_engine(app, &self.last_ui, notify);
        }
        Ok(())
    }

    pub(crate) fn shutdown(&self, app: &tauri::AppHandle) {
        let _ = self.send(app, PlayerCommand::Shutdown, false);
        if let Ok(mut actor) = self.actor.lock() {
            actor.take();
        }
    }
}

fn ensure_player_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        PLAYER_WINDOW_LABEL,
        WebviewUrl::App("player.html".into()),
    )
    .title("Triboon Player")
    .decorations(false)
    .fullscreen(true)
    .visible(false)
    .transparent(true)
    .on_navigation(|url| crate::is_internal_app_url(url.as_str()))
    .build()
    .map_err(|e| format!("could not create the native player window: {e}"))?;

    let close_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(controller) = close_app.try_state::<PlayerController>() {
                let _ = controller.close(&close_app, true);
            }
        }
    });
    Ok(window)
}

/// Build the hidden local player WebView while Tauri is still in its setup callback. Creating a
/// second WebView lazily from a synchronous remote-origin IPC command can deadlock WebView2's UI
/// dispatcher on Windows, leaving the catalog waiting forever before the player is shown.
pub(crate) fn initialize_player_window(app: &tauri::AppHandle) -> Result<(), String> {
    ensure_player_window(app).map(|_| ())
}

#[cfg(target_os = "windows")]
fn player_surface_id(window: &WebviewWindow) -> Result<i64, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    // mpv's Win32 contract requires HWND to be passed through uint32_t; signed/pointer-sized casts
    // can turn a valid handle into a negative value that mpv rejects.
    let surface = hwnd.0 as usize as u32;
    if surface == 0 {
        return Err("native player window handle is unavailable".into());
    }
    Ok(i64::from(surface))
}

#[cfg(not(target_os = "windows"))]
fn player_surface_id(_window: &WebviewWindow) -> Result<i64, String> {
    Err("native player surfaces are available only on Windows".into())
}

fn show_player(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    let player = ensure_player_window(app)?;
    let _ = player.set_always_on_top(false);
    let _ = player.set_fullscreen(true);
    player.show().map_err(|e| e.to_string())?;
    let _ = player.set_focus();
    if let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) {
        let _ = main.hide();
    }
    eval_callback(app, "__tvNativePlaybackSurfaceReady", Vec::new());
    Ok(player)
}

fn show_catalog(app: &tauri::AppHandle) {
    if let Some(player) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
        let _ = player.set_always_on_top(false);
        let _ = player.hide();
    }
    if let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn eval_player_state(window: &WebviewWindow, state: &PlayerUiState) {
    let Ok(payload) = serde_json::to_string(state) else {
        return;
    };
    // The local player intentionally has no global Tauri API. Deliver its validated state through
    // one callback instead of granting the much broader core:event permission.
    let script = format!(
        "(()=>{{const f=window.__triboonWindowsPlayerEvent;if(typeof f==='function')f({payload});}})()"
    );
    let _ = window.eval(script);
}

fn publish_ui(app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerUiState>>, state: PlayerUiState) {
    if let Ok(mut current) = shared.lock() {
        *current = state.clone();
    }
    if let Some(window) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
        eval_player_state(&window, &state);
    }
}

fn publish_current_ui(app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerUiState>>) {
    let current = shared.lock().map(|state| state.clone()).unwrap_or_default();
    if let Some(window) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
        eval_player_state(&window, &current);
    }
}

fn close_without_engine(app: &tauri::AppHandle, shared: &Arc<Mutex<PlayerUiState>>, notify: bool) {
    let snapshot = shared.lock().map(|state| state.clone()).unwrap_or_default();
    if notify {
        if snapshot.token > 0 {
            eval_callback(
                app,
                "__tvNativeVideoClosed",
                vec![
                    json!(snapshot.pos),
                    json!(snapshot.duration),
                    json!(false),
                    json!(snapshot.token),
                ],
            );
        } else if snapshot.is_live {
            eval_callback(app, "__tvNativeLiveClosed", Vec::new());
        }
    }
    publish_ui(
        app,
        shared,
        PlayerUiState {
            event_type: "closed".into(),
            ..PlayerUiState::default()
        },
    );
    show_catalog(app);
}

fn eval_callback(app: &tauri::AppHandle, name: &str, args: Vec<Value>) {
    let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) else {
        return;
    };
    let Ok(name_json) = serde_json::to_string(name) else {
        return;
    };
    let args = args
        .into_iter()
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| "null".into()))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "(()=>{{const f=window[{name_json}];if(typeof f==='function')return f({args});}})()"
    );
    let _ = main.eval(script);
}

#[tauri::command]
pub fn windows_player_show_loading(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    controller: State<'_, PlayerController>,
    mut payload: LoadingPayload,
) -> Result<(), String> {
    let server = require_catalog_origin(&window, &state)?;
    validate_text(&payload.title, "title", MAX_TEXT)?;
    payload.backdrop_url = validated_optional_artwork(&payload.backdrop_url, &server)?;
    show_player(&app)?;
    controller.enter_loading(&app, PlayerUiState::loading(&payload))
}

#[tauri::command]
pub fn windows_player_play_vod(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    controller: State<'_, PlayerController>,
    payload: VodPayload,
) -> Result<(), String> {
    let server = require_catalog_origin(&window, &state)?;
    let request = validate_vod(payload, &server)?;
    show_player(&app)?;
    controller.send(&app, PlayerCommand::PlayVod(request), true)
}

#[tauri::command]
pub fn windows_player_play_live(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    controller: State<'_, PlayerController>,
    payload: LivePayload,
) -> Result<(), String> {
    let server = require_catalog_origin(&window, &state)?;
    let request = validate_live(payload, &server)?;
    show_player(&app)?;
    controller.send(&app, PlayerCommand::PlayLive(request), true)
}

#[tauri::command]
pub fn windows_player_control(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    controller: State<'_, PlayerController>,
    action: String,
    payload: Value,
) -> Result<(), String> {
    let server = require_player_or_catalog(&window, &state)?;
    let parsed = parse_control(&action, payload, server.as_deref())?;
    match &parsed {
        ControlAction::RequestState => {
            publish_current_ui(&app, &controller.last_ui);
            return Ok(());
        }
        ControlAction::Close => return controller.close(&app, true),
        ControlAction::ToggleFullscreen => {
            if let Some(player) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
                let fullscreen = player.is_fullscreen().unwrap_or(false);
                player
                    .set_fullscreen(!fullscreen)
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        ControlAction::Minimize => {
            if let Some(player) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
                player.minimize().map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        _ => {}
    }
    if matches!(parsed, ControlAction::OpenGuide) {
        enter_guide_mode(&app)?;
    } else if matches!(parsed, ControlAction::CloseGuide) {
        leave_guide_mode(&app)?;
    }
    controller.send(&app, PlayerCommand::Control(parsed), false)
}

#[tauri::command]
pub fn windows_player_update(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    controller: State<'_, PlayerController>,
    kind: String,
    payload: Value,
) -> Result<(), String> {
    let server = require_catalog_origin(&window, &state)?;
    let update = parse_update(&kind, payload, &server)?;
    controller.send(&app, PlayerCommand::Update(update), false)
}

fn enter_guide_mode(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) {
        main.show().map_err(|e| e.to_string())?;
        let _ = main.set_focus();
    }
    if let Some(player) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
        let _ = player.set_fullscreen(false);
        let _ = player.set_size(tauri::LogicalSize::new(480.0, 270.0));
        let _ = player.set_position(tauri::LogicalPosition::new(24.0, 24.0));
        let _ = player.set_always_on_top(true);
    }
    Ok(())
}

fn leave_guide_mode(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) {
        let _ = main.hide();
    }
    if let Some(player) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
        let _ = player.set_always_on_top(false);
        let _ = player.set_fullscreen(true);
        player.show().map_err(|e| e.to_string())?;
        let _ = player.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn windows_player_open_guide(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    controller: State<'_, PlayerController>,
) -> Result<(), String> {
    require_player_or_catalog(&window, &state)?;
    enter_guide_mode(&app)?;
    controller.send(
        &app,
        PlayerCommand::Control(ControlAction::OpenGuide),
        false,
    )?;
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(9_007_199_254_740_991) as u64)
        .unwrap_or(0);
    eval_callback(&app, "__tvNativeLiveGuide", vec![json!(epoch)]);
    Ok(())
}

#[tauri::command]
pub fn windows_player_close_guide(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    controller: State<'_, PlayerController>,
) -> Result<(), String> {
    require_player_or_catalog(&window, &state)?;
    leave_guide_mode(&app)?;
    controller.send(
        &app,
        PlayerCommand::Control(ControlAction::CloseGuide),
        false,
    )
}

#[tauri::command]
pub fn windows_player_set_guide_pip_rect(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    payload: GuideRect,
) -> Result<(), String> {
    require_catalog_origin(&window, &state)?;
    for value in [payload.x, payload.y, payload.width, payload.height] {
        if !value.is_finite() || value.abs() > 100_000.0 {
            return Err("guide rectangle is invalid".into());
        }
    }
    if payload.width < 240.0 || payload.height < 135.0 {
        return Err("guide player rectangle is too small".into());
    }
    let player = ensure_player_window(&app)?;
    let (origin_x, origin_y) = if let Some(main) = app.get_webview_window(CONNECT_WINDOW_LABEL) {
        let scale = main.scale_factor().unwrap_or(1.0).max(0.1);
        main.inner_position()
            .map(|position| (position.x as f64 / scale, position.y as f64 / scale))
            .unwrap_or((0.0, 0.0))
    } else {
        (0.0, 0.0)
    };
    let _ = player.set_fullscreen(false);
    player
        .set_position(tauri::LogicalPosition::new(
            origin_x + payload.x,
            origin_y + payload.y,
        ))
        .map_err(|e| e.to_string())?;
    player
        .set_size(tauri::LogicalSize::new(payload.width, payload.height))
        .map_err(|e| e.to_string())?;
    let _ = player.set_always_on_top(true);
    let _ = player.show();
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionMode {
    Vod,
    Live,
}

#[derive(Debug)]
struct NativeSession {
    mode: SessionMode,
    token: u64,
    kind: String,
    candidates: Vec<PlaybackCandidate>,
    candidate_index: usize,
    start: f64,
    start_offset: f64,
    start_fraction: f64,
    duration_hint: f64,
    buffer_goal_sec: u32,
    subtitle: SubtitleRequest,
    ready: bool,
    start_seen: bool,
    file_loaded: bool,
    playback_restarted: bool,
    video_reconfigured: bool,
    subtitle_attached: bool,
    ended: bool,
    error_sent: bool,
    requested_playing: bool,
    last_raw_pos: f64,
    last_position: f64,
    last_duration: f64,
    last_paused: Option<bool>,
    loaded_at: Instant,
    buffering_since: Option<Instant>,
    last_progress: Instant,
    last_stats: Instant,
    ui: PlayerUiState,
}

impl NativeSession {
    fn from_vod(request: VodRequest) -> Self {
        let episode_focus_index = request
            .episode_choices
            .iter()
            .position(|episode| episode.get("current").and_then(Value::as_bool) == Some(true))
            .unwrap_or(0);
        let ui = PlayerUiState {
            event_type: if request.quiet_seek {
                "source_replacing".into()
            } else {
                "session".into()
            },
            token: request.token,
            title: request.title,
            episode_label: request.episode_label,
            source: request.source,
            backdrop_url: request.backdrop_url,
            is_live: false,
            buffering: true,
            quality_label: request.quality_label,
            source_size: request.size,
            subtitle_rel: request.subtitle.rel.clone(),
            subtitle_label: request.subtitle.label.clone(),
            subtitle_choices: request.subtitle_choices,
            episode_choices: request.episode_choices,
            episode_focus_index,
            has_next: request.has_next,
            has_quality_choices: request.quality_choices,
            message: if request.percent_resume {
                "Resuming".into()
            } else {
                String::new()
            },
            ..PlayerUiState::default()
        };
        Self {
            mode: SessionMode::Vod,
            token: request.token,
            kind: request.kind,
            candidates: vec![PlaybackCandidate {
                url: request.url,
                host_header: String::new(),
            }],
            candidate_index: 0,
            start: request.start,
            start_offset: request.start_offset,
            start_fraction: request.start_fraction,
            duration_hint: request.duration,
            buffer_goal_sec: request.buffer_goal_sec,
            subtitle: request.subtitle,
            ready: false,
            start_seen: false,
            file_loaded: false,
            playback_restarted: false,
            video_reconfigured: false,
            subtitle_attached: false,
            ended: false,
            error_sent: false,
            requested_playing: true,
            last_raw_pos: 0.0,
            last_position: request.start.max(request.start_offset),
            last_duration: request.duration,
            last_paused: None,
            loaded_at: Instant::now(),
            buffering_since: None,
            last_progress: Instant::now(),
            last_stats: Instant::now(),
            ui,
        }
    }

    fn from_live(request: LiveRequest) -> Self {
        Self {
            mode: SessionMode::Live,
            token: 0,
            kind: "live".into(),
            candidates: request.candidates,
            candidate_index: 0,
            start: 0.0,
            start_offset: 0.0,
            start_fraction: 0.0,
            duration_hint: 0.0,
            buffer_goal_sec: 24,
            subtitle: SubtitleRequest {
                rel: String::new(),
                url: String::new(),
                lang: String::new(),
                label: String::new(),
                shift: 0.0,
                size: String::new(),
                startup: false,
            },
            ready: false,
            start_seen: false,
            file_loaded: false,
            playback_restarted: false,
            video_reconfigured: false,
            subtitle_attached: true,
            ended: false,
            error_sent: false,
            requested_playing: true,
            last_raw_pos: 0.0,
            last_position: 0.0,
            last_duration: 0.0,
            last_paused: None,
            loaded_at: Instant::now(),
            buffering_since: None,
            last_progress: Instant::now(),
            last_stats: Instant::now(),
            ui: PlayerUiState {
                event_type: "session".into(),
                title: request.title,
                source: request.source,
                is_live: true,
                buffering: true,
                quality_label: "LIVE".into(),
                guide: request.guide,
                ..PlayerUiState::default()
            },
        }
    }

    fn server_seek(&self) -> bool {
        self.mode == SessionMode::Vod && matches!(self.kind.as_str(), "remux" | "transcode")
    }

    fn display_position(&self, raw: f64) -> f64 {
        if self.server_seek() {
            self.start_offset + raw
        } else {
            raw
        }
    }

    fn display_duration(&self, raw_duration: f64) -> f64 {
        if self.duration_hint > 0.0 {
            self.duration_hint
        } else if self.server_seek() && raw_duration > 0.0 {
            self.start_offset + raw_duration
        } else {
            raw_duration
        }
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn actor_loop(
    app: tauri::AppHandle,
    surface: i64,
    rx: Receiver<PlayerCommand>,
    shared: Arc<Mutex<PlayerUiState>>,
) {
    let mpv = match create_mpv(surface) {
        Ok(mpv) => mpv,
        Err(error) => {
            actor_init_failed(&app, rx, &shared, &error);
            return;
        }
    };
    let mut session: Option<NativeSession> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(PlayerCommand::ShowLoading(state)) => {
                flush_progress(&app, session.as_mut());
                let _ = mpv.command("stop", &[]);
                session = None;
                publish_ui(&app, &shared, state);
            }
            Ok(PlayerCommand::PlayVod(request)) => {
                flush_progress(&app, session.as_mut());
                let mut next = NativeSession::from_vod(request);
                if let Err(error) = load_session(&mpv, &mut next) {
                    notify_error(&app, &mut next, &format!("native playback failed: {error}"));
                }
                publish_ui(&app, &shared, next.ui.clone());
                session = Some(next);
            }
            Ok(PlayerCommand::PlayLive(request)) => {
                flush_progress(&app, session.as_mut());
                let mut next = NativeSession::from_live(request);
                if let Err(error) = load_session(&mpv, &mut next) {
                    if !try_live_fallback(&mpv, &mut next) {
                        notify_error(&app, &mut next, &format!("live playback failed: {error}"));
                    }
                }
                publish_ui(&app, &shared, next.ui.clone());
                session = Some(next);
            }
            Ok(PlayerCommand::Control(action)) => {
                if handle_control(&app, &mpv, &mut session, action, &shared) {
                    break;
                }
            }
            Ok(PlayerCommand::Update(update)) => {
                handle_update(&app, &mpv, session.as_mut(), update, &shared);
            }
            Ok(PlayerCommand::Close { notify }) => {
                close_session(&app, &mpv, &mut session, notify, &shared);
            }
            Ok(PlayerCommand::Shutdown) => {
                flush_progress(&app, session.as_mut());
                let _ = mpv.command("stop", &[]);
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                flush_progress(&app, session.as_mut());
                let _ = mpv.command("stop", &[]);
                break;
            }
        }
        if let Some(active) = session.as_mut() {
            tick_session(&app, &mpv, active, &shared);
        }
    }
}

#[cfg(not(all(feature = "player", target_os = "windows")))]
fn actor_loop(
    app: tauri::AppHandle,
    _surface: i64,
    rx: Receiver<PlayerCommand>,
    shared: Arc<Mutex<PlayerUiState>>,
) {
    while let Ok(command) = rx.recv() {
        match command {
            PlayerCommand::ShowLoading(state) => publish_ui(&app, &shared, state),
            PlayerCommand::PlayVod(request) => {
                let mut state = NativeSession::from_vod(request).ui;
                state.event_type = "error".into();
                state.message = "native libmpv support is not included in this build".into();
                eval_callback(
                    &app,
                    "__tvNativeVideoError",
                    vec![json!(state.message), json!(0), json!(0), json!(state.token)],
                );
                publish_ui(&app, &shared, state);
            }
            PlayerCommand::PlayLive(request) => {
                let mut state = NativeSession::from_live(request).ui;
                state.event_type = "error".into();
                state.message = "native libmpv support is not included in this build".into();
                eval_callback(&app, "__tvNativeLiveError", vec![json!(state.message)]);
                publish_ui(&app, &shared, state);
            }
            PlayerCommand::Close { notify } => close_without_engine(&app, &shared, notify),
            PlayerCommand::Shutdown => break,
            PlayerCommand::Control(ControlAction::Close) => {
                close_without_engine(&app, &shared, true)
            }
            PlayerCommand::Control(_) | PlayerCommand::Update(_) => {}
        }
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn create_mpv(surface: i64) -> Result<libmpv2::Mpv, String> {
    libmpv2::Mpv::with_initializer(|init| {
        init.set_option("wid", surface)?;
        init.set_option("vo", "gpu-next")?;
        init.set_option("gpu-api", "d3d11")?;
        init.set_option("hwdec", "auto-safe")?;
        init.set_option("hwdec-codecs", "all")?;
        init.set_option("target-colorspace-hint", "yes")?;
        init.set_option("keep-open", "yes")?;
        init.set_option("keep-open-pause", "no")?;
        init.set_option("osc", "no")?;
        init.set_option("input-default-bindings", "no")?;
        init.set_option("input-vo-keyboard", "no")?;
        init.set_option("input-cursor-passthrough", "yes")?;
        init.set_option("terminal", "no")?;
        init.set_option("msg-level", "all=no")?;
        init.set_option("cache", "yes")?;
        init.set_option("audio-client-name", "Triboon")?;
        Ok(())
    })
    .map_err(|e| format!("libmpv initialization: {e}"))
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn actor_init_failed(
    app: &tauri::AppHandle,
    rx: Receiver<PlayerCommand>,
    shared: &Arc<Mutex<PlayerUiState>>,
    error: &str,
) {
    let safe = if error.to_ascii_lowercase().contains("version") {
        "The bundled libmpv version is incompatible with this Triboon build"
    } else {
        "The native video engine could not start"
    };
    loop {
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(PlayerCommand::ShowLoading(state)) => publish_ui(app, shared, state),
            Ok(PlayerCommand::PlayVod(request)) => {
                let mut state = NativeSession::from_vod(request).ui;
                eval_callback(
                    app,
                    "__tvNativeVideoError",
                    vec![json!(safe), json!(0), json!(0), json!(state.token)],
                );
                state.event_type = "error".into();
                state.message = safe.into();
                publish_ui(app, shared, state);
            }
            Ok(PlayerCommand::PlayLive(request)) => {
                eval_callback(app, "__tvNativeLiveError", vec![json!(safe)]);
                let mut state = NativeSession::from_live(request).ui;
                state.event_type = "error".into();
                state.message = safe.into();
                publish_ui(app, shared, state);
            }
            Ok(PlayerCommand::Close { notify }) => {
                close_without_engine(app, shared, notify);
                return;
            }
            Ok(PlayerCommand::Shutdown) => return,
            Ok(PlayerCommand::Control(ControlAction::Close)) => {
                close_without_engine(app, shared, true);
                return;
            }
            Ok(PlayerCommand::Control(_)) | Ok(PlayerCommand::Update(_)) => {}
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn likely_heavy_vod(source_size: u64, quality_label: &str) -> bool {
    const HEAVY_SIZE: u64 = 18 * 1024 * 1024 * 1024;
    let quality = quality_label.to_ascii_lowercase();
    source_size >= HEAVY_SIZE
        || quality.contains("2160")
        || quality.contains("4k")
        || quality.contains("uhd")
}

fn cache_bytes(
    goal_seconds: u32,
    source_size: u64,
    duration_seconds: f64,
    quality_label: &str,
) -> i64 {
    const MIB: f64 = 1024.0 * 1024.0;
    const MIN_BYTES: f64 = 64.0 * MIB;
    const MAX_BYTES: f64 = 768.0 * MIB;
    let seconds = goal_seconds.clamp(8, 300) as f64;
    let heavy = likely_heavy_vod(source_size, quality_label);
    let measured = source_size > 0 && duration_seconds.is_finite() && duration_seconds > 0.0;
    let target = if measured {
        seconds * source_size as f64 / duration_seconds
    } else {
        // Match the Android player's conservative first-play estimates when the server has not yet
        // supplied enough metadata to calculate the real bitrate: about 48 Mbps for 4K and 13 Mbps
        // for ordinary HD, while retaining a useful baseline buffer for each tier.
        let estimated_bytes_per_second = if heavy { 6.0 * MIB } else { 1.6 * MIB };
        let baseline = if heavy { 384.0 * MIB } else { 96.0 * MIB };
        (seconds * estimated_bytes_per_second).max(baseline)
    };
    target.ceil().clamp(MIN_BYTES, MAX_BYTES) as i64
}

fn loadfile_options(start: f64, host_header: &str) -> Option<String> {
    let mut options = Vec::new();
    if start > 0.0 {
        options.push(format!("start={start:.3}"));
    }
    if !host_header.is_empty() {
        options.push(format!("http-header-fields=Host:{host_header}"));
    }
    (!options.is_empty()).then(|| options.join(","))
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn load_session(mpv: &libmpv2::Mpv, session: &mut NativeSession) -> Result<(), String> {
    let candidate = session
        .candidates
        .get(session.candidate_index)
        .ok_or_else(|| "no media candidate".to_string())?;
    // Drop lifecycle events belonging to the previous file before arming this session. `loadfile`
    // is asynchronous; the new StartFile/FileLoaded sequence below is the generation boundary.
    while mpv.wait_event(0.0).is_some() {}
    session.start_seen = false;
    session.file_loaded = false;
    session.playback_restarted = false;
    session.video_reconfigured = false;
    session.subtitle_attached = session.subtitle.url.is_empty();
    mpv.set_property(
        "demuxer-max-bytes",
        cache_bytes(
            session.buffer_goal_sec,
            session.ui.source_size,
            session.duration_hint,
            &session.ui.quality_label,
        ),
    )
    .map_err(|e| e.to_string())?;
    mpv.set_property(
        "demuxer-readahead-secs",
        session.buffer_goal_sec.clamp(8, 300) as i64,
    )
    .map_err(|e| e.to_string())?;
    mpv.set_property("force-media-title", session.ui.title.as_str())
        .map_err(|e| e.to_string())?;
    let mut start = session.start;
    if session.mode == SessionMode::Vod
        && !session.server_seek()
        && start <= 0.0
        && session.start_fraction > 0.0
        && session.duration_hint > 0.0
    {
        start = session.start_fraction * session.duration_hint;
        session.start_fraction = 0.0;
    }
    if let Some(options) = loadfile_options(start, &candidate.host_header) {
        mpv.command(
            "loadfile",
            &[candidate.url.as_str(), "replace", "-1", options.as_str()],
        )
        .map_err(|e| e.to_string())?;
    } else {
        mpv.command("loadfile", &[candidate.url.as_str(), "replace"])
            .map_err(|e| e.to_string())?;
    }
    mpv.set_property("pause", false)
        .map_err(|e| e.to_string())?;
    session.ready = false;
    session.ended = false;
    session.error_sent = false;
    session.requested_playing = true;
    session.loaded_at = Instant::now();
    session.buffering_since = None;
    session.last_paused = None;
    session.ui.event_type = "loading".into();
    session.ui.buffering = true;
    session.ui.playing = false;
    Ok(())
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn subtitle_scale(size: &str) -> f64 {
    match size.trim().to_ascii_uppercase().as_str() {
        "XXS" => 0.62,
        "XS" => 0.76,
        "S" => 0.9,
        "L" => 1.18,
        "XL" => 1.34,
        "XXL" => 1.52,
        _ => 1.0,
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn apply_subtitle(mpv: &libmpv2::Mpv, subtitle: &SubtitleRequest) -> Result<(), String> {
    if subtitle.url.is_empty() {
        mpv.set_property("sid", "no").map_err(|e| e.to_string())?;
        return Ok(());
    }
    let _ = mpv.command("sub-remove", &[]);
    let label = if subtitle.label.is_empty() {
        "Triboon subtitles"
    } else {
        subtitle.label.as_str()
    };
    mpv.command(
        "sub-add",
        &[
            subtitle.url.as_str(),
            "select",
            label,
            subtitle.lang.as_str(),
        ],
    )
    .map_err(|e| {
        if subtitle.startup {
            "subtitle is still preparing".to_string()
        } else {
            format!("could not load subtitle: {e}")
        }
    })?;
    mpv.set_property("sub-delay", subtitle.shift)
        .map_err(|e| e.to_string())?;
    mpv.set_property("sub-scale", subtitle_scale(&subtitle.size))
        .map_err(|e| e.to_string())
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn property<T: libmpv2::GetData>(mpv: &libmpv2::Mpv, name: &str) -> Option<T> {
    mpv.get_property(name).ok()
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn current_file_eof(start_seen: bool, file_loaded: bool, reason: libmpv2::EndFileReason) -> bool {
    start_seen && file_loaded && reason == libmpv2::mpv_end_file_reason::Eof
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn drain_session_events(mpv: &libmpv2::Mpv, session: &mut NativeSession) -> (bool, Option<String>) {
    let mut eof = false;
    let mut error = None;
    while let Some(event) = mpv.wait_event(0.0) {
        match event {
            Ok(libmpv2::events::Event::StartFile) => {
                session.start_seen = true;
                session.file_loaded = false;
                session.playback_restarted = false;
                session.video_reconfigured = false;
                session.subtitle_attached = session.subtitle.url.is_empty();
            }
            Ok(libmpv2::events::Event::FileLoaded) if session.start_seen => {
                session.file_loaded = true;
            }
            Ok(libmpv2::events::Event::PlaybackRestart) if session.file_loaded => {
                session.playback_restarted = true;
            }
            Ok(libmpv2::events::Event::VideoReconfig) if session.file_loaded => {
                session.video_reconfigured = true;
            }
            Ok(libmpv2::events::Event::EndFile(reason)) => {
                if current_file_eof(session.start_seen, session.file_loaded, reason) {
                    eof = true;
                }
            }
            Err(event_error) if session.start_seen => {
                error = Some(redact_url_query(&event_error.to_string()));
            }
            _ => {}
        }
    }
    (eof, error)
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn tick_session(
    app: &tauri::AppHandle,
    mpv: &libmpv2::Mpv,
    session: &mut NativeSession,
    shared: &Arc<Mutex<PlayerUiState>>,
) {
    if session.ended || session.error_sent {
        return;
    }
    let (eof, event_error) = drain_session_events(mpv, session);
    if let Some(error) = event_error {
        notify_error(app, session, &format!("native media error: {error}"));
        publish_ui(app, shared, session.ui.clone());
        return;
    }
    if session.file_loaded && !session.subtitle_attached {
        session.subtitle_attached = true;
        if apply_subtitle(mpv, &session.subtitle).is_err() {
            session.ui.subtitle_rel.clear();
            session.ui.subtitle_label.clear();
        }
    }
    let raw_position = property::<f64>(mpv, "time-pos").unwrap_or(session.last_raw_pos);
    let raw_duration = property::<f64>(mpv, "duration").unwrap_or(0.0);
    let paused = property::<bool>(mpv, "pause").unwrap_or(!session.requested_playing);
    let buffering = property::<bool>(mpv, "paused-for-cache").unwrap_or(false);
    let idle = property::<bool>(mpv, "idle-active").unwrap_or(false);
    let configured = property::<bool>(mpv, "vo-configured").unwrap_or(false);
    let width = property::<i64>(mpv, "video-out-params/w").unwrap_or(0);
    let height = property::<i64>(mpv, "video-out-params/h").unwrap_or(0);

    session.last_raw_pos = raw_position.max(0.0);
    session.last_position = session.display_position(session.last_raw_pos).max(0.0);
    session.last_duration = session.display_duration(raw_duration).max(0.0);
    session.ui.pos = session.last_position;
    session.ui.duration = session.last_duration;
    session.ui.paused = paused;
    session.ui.playing = !paused && !buffering && session.ready;
    session.ui.buffering = buffering || !session.ready;

    let now = Instant::now();
    if !session.ready
        && session.file_loaded
        && (session.playback_restarted
            || session.video_reconfigured
            || configured
            || width > 0
            || height > 0
            || raw_position > 0.0)
    {
        if session.start_fraction > 0.0 && session.last_duration > 0.0 {
            let target = session.start_fraction * session.last_duration;
            session.start_fraction = 0.0;
            if session.server_seek() {
                let _ = mpv.set_property("pause", true);
                eval_callback(
                    app,
                    "__tvNativeVideoSeek",
                    vec![
                        json!(target),
                        json!(session.last_duration),
                        json!(true),
                        json!(session.token),
                        json!(true),
                    ],
                );
                return;
            }
            let target_string = format!("{target:.3}");
            let _ = mpv.command("seek", &[target_string.as_str(), "absolute+keyframes"]);
        }
        session.ready = true;
        session.ui.event_type = "state_snapshot".into();
        session.ui.buffering = false;
        if session.mode == SessionMode::Vod {
            eval_callback(
                app,
                "__tvNativeVideoReady",
                vec![
                    json!(session.last_position),
                    json!(session.last_duration),
                    json!(session.token),
                ],
            );
        } else {
            eval_callback(app, "__tvNativeLiveReady", Vec::new());
        }
        publish_ui(app, shared, session.ui.clone());
    }

    if eof && session.ready {
        flush_progress(app, Some(session));
        if session.mode == SessionMode::Vod {
            session.ended = true;
            session.ui.event_type = "ended".into();
            session.ui.playing = false;
            session.ui.buffering = false;
            if session.last_duration > 0.0 {
                session.last_position = session.last_duration;
                session.ui.pos = session.last_duration;
            }
            eval_callback(
                app,
                "__tvNativeVideoEnded",
                vec![
                    json!(session.last_position),
                    json!(session.last_duration),
                    json!(session.token),
                ],
            );
            publish_ui(app, shared, session.ui.clone());
        } else if !try_live_fallback(mpv, session) {
            notify_error(app, session, "live stream ended");
        }
        return;
    }

    if buffering {
        session.buffering_since.get_or_insert(now);
    } else {
        session.buffering_since = None;
    }

    if !session.ready {
        let timeout = if session.mode == SessionMode::Live {
            LIVE_STARTUP_TIMEOUT
        } else {
            VOD_STARTUP_TIMEOUT
        };
        if now.duration_since(session.loaded_at) >= timeout
            || (session.start_seen
                && idle
                && now.duration_since(session.loaded_at) > Duration::from_secs(3))
        {
            if session.mode == SessionMode::Live && try_live_fallback(mpv, session) {
                publish_ui(app, shared, session.ui.clone());
                return;
            }
            notify_error(app, session, "native player startup timed out");
            publish_ui(app, shared, session.ui.clone());
            return;
        }
    } else if let Some(since) = session.buffering_since {
        let timeout = if session.mode == SessionMode::Live {
            LIVE_REBUFFER_TIMEOUT
        } else {
            VOD_REBUFFER_TIMEOUT
        };
        if now.duration_since(since) >= timeout {
            if session.mode == SessionMode::Live && try_live_fallback(mpv, session) {
                publish_ui(app, shared, session.ui.clone());
                return;
            }
            notify_error(app, session, "native playback stalled while buffering");
            publish_ui(app, shared, session.ui.clone());
            return;
        }
    }

    if session.last_paused != Some(paused) && session.ready {
        session.last_paused = Some(paused);
        if session.mode == SessionMode::Vod {
            eval_callback(
                app,
                if paused {
                    "__tvNativeVideoPaused"
                } else {
                    "__tvNativeVideoPlaying"
                },
                vec![
                    json!(session.last_position),
                    json!(session.last_duration),
                    json!(session.token),
                ],
            );
        }
        publish_ui(app, shared, session.ui.clone());
    }

    if now.duration_since(session.last_progress) >= Duration::from_secs(1) {
        session.last_progress = now;
        if session.mode == SessionMode::Vod {
            eval_callback(
                app,
                "__tvNativeVideoProgress",
                vec![
                    json!(session.last_position),
                    json!(session.last_duration),
                    json!(session.token),
                ],
            );
        }
        publish_ui(app, shared, session.ui.clone());
    }
    if now.duration_since(session.last_stats) >= Duration::from_secs(2) {
        session.last_stats = now;
        update_stats(mpv, session);
        let stats = stats_value(&session.ui);
        eval_callback(
            app,
            "__tvNativeVideoStats",
            vec![stats, json!(session.token)],
        );
        publish_ui(app, shared, session.ui.clone());
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn update_stats(mpv: &libmpv2::Mpv, session: &mut NativeSession) {
    session.ui.buffered = property::<f64>(mpv, "demuxer-cache-duration")
        .unwrap_or(0.0)
        .max(0.0);
    session.ui.volume = property::<f64>(mpv, "volume").unwrap_or(session.ui.volume);
    session.ui.muted = property::<bool>(mpv, "mute").unwrap_or(false);
    session.ui.hwdec = property::<String>(mpv, "hwdec-current").unwrap_or_default();
    let normalized = session.ui.hwdec.to_ascii_lowercase();
    session.ui.hwdec_active = !normalized.is_empty()
        && !matches!(normalized.as_str(), "no" | "none" | "software" | "disabled");
    session.ui.video_codec = property::<String>(mpv, "video-codec").unwrap_or_default();
    session.ui.audio_codec = property::<String>(mpv, "audio-codec-name").unwrap_or_default();
    session.ui.audio_label = property::<String>(mpv, "audio-codec-name").unwrap_or_default();
    update_audio_tracks(mpv, &mut session.ui);
    session.ui.width = property::<i64>(mpv, "video-out-params/w").unwrap_or(0);
    session.ui.height = property::<i64>(mpv, "video-out-params/h").unwrap_or(0);
    session.ui.fps = property::<f64>(mpv, "estimated-vf-fps").unwrap_or(0.0);
    session.ui.dropped_frames = property::<i64>(mpv, "decoder-frame-drop-count").unwrap_or(0);
    session.ui.bitrate = property::<i64>(mpv, "cache-speed")
        .unwrap_or(0)
        .saturating_mul(8);
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn update_audio_tracks(mpv: &libmpv2::Mpv, ui: &mut PlayerUiState) {
    let previous = ui.audio_id.clone();
    let count = property::<i64>(mpv, "track-list/count")
        .unwrap_or(0)
        .clamp(0, 64);
    let mut tracks = Vec::new();
    let mut active = String::new();
    for index in 0..count {
        let prefix = format!("track-list/{index}");
        if property::<String>(mpv, &format!("{prefix}/type")).as_deref() != Some("audio") {
            continue;
        }
        let id = property::<i64>(mpv, &format!("{prefix}/id"))
            .unwrap_or(index)
            .to_string();
        let lang = property::<String>(mpv, &format!("{prefix}/lang")).unwrap_or_default();
        let title = property::<String>(mpv, &format!("{prefix}/title")).unwrap_or_default();
        let codec = property::<String>(mpv, &format!("{prefix}/codec")).unwrap_or_default();
        let selected = property::<bool>(mpv, &format!("{prefix}/selected")).unwrap_or(false);
        if selected {
            active = id.clone();
            ui.audio_label = if !title.is_empty() {
                title.clone()
            } else if !lang.is_empty() {
                lang.to_ascii_uppercase()
            } else {
                codec.clone()
            };
        }
        tracks.push(json!({
            "id": id,
            "label": if !title.is_empty() {
                title
            } else if !lang.is_empty() {
                lang.to_ascii_uppercase()
            } else if !codec.is_empty() {
                codec.clone()
            } else {
                format!("Audio {}", tracks.len() + 1)
            },
            "lang": lang,
            "codec": codec,
            "selected": selected
        }));
    }
    let mut resolved = if active.is_empty() {
        property::<String>(mpv, "aid")
            .filter(|value| !matches!(value.as_str(), "auto" | "no"))
            .or_else(|| property::<i64>(mpv, "aid").map(|value| value.to_string()))
            .unwrap_or_default()
    } else {
        active
    };
    if resolved.is_empty()
        && tracks
            .iter()
            .any(|track| track.get("id").and_then(Value::as_str) == Some(previous.as_str()))
    {
        // Some output-less sessions (for example a locked Windows desktop in automated QA) do
        // not expose a selected flag even after mpv accepts `set aid`. Keep the accepted track
        // visible instead of making the audio menu immediately lose its selection.
        resolved = previous;
    }
    if let Some(track) = tracks
        .iter()
        .find(|track| track.get("id").and_then(Value::as_str) == Some(resolved.as_str()))
    {
        if let Some(label) = track.get("label").and_then(Value::as_str) {
            ui.audio_label = label.to_string();
        }
        if ui.audio_codec.is_empty() {
            if let Some(codec) = track.get("codec").and_then(Value::as_str) {
                ui.audio_codec = codec.to_string();
            }
        }
    }
    ui.audio_tracks = tracks;
    ui.audio_id = resolved;
}

fn stats_value(ui: &PlayerUiState) -> Value {
    json!({
        "player": "libmpv",
        "path": if ui.is_live { "live" } else { "native" },
        "quality": ui.quality_label,
        "size": ui.source_size,
        "video": ui.video_codec,
        "audio": ui.audio_codec,
        "audioId": ui.audio_id,
        "audioLabel": ui.audio_label,
        "audioTracks": ui.audio_tracks,
        "message": ui.message,
        "bufferedSec": ui.buffered,
        "bandwidth": ui.bitrate,
        "hwdec": ui.hwdec,
        "hwdecActive": ui.hwdec_active,
        "width": ui.width,
        "height": ui.height,
        "fps": ui.fps,
        "droppedFrames": ui.dropped_frames
    })
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn flush_progress(app: &tauri::AppHandle, session: Option<&mut NativeSession>) {
    let Some(session) = session else { return };
    if session.mode == SessionMode::Vod && session.token > 0 {
        eval_callback(
            app,
            "__tvNativeVideoProgress",
            vec![
                json!(session.last_position),
                json!(session.last_duration),
                json!(session.token),
            ],
        );
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn notify_error(app: &tauri::AppHandle, session: &mut NativeSession, message: &str) {
    if session.error_sent {
        return;
    }
    session.error_sent = true;
    session.ui.event_type = "error".into();
    session.ui.playing = false;
    session.ui.buffering = false;
    let message = redact_url_query(message);
    session.ui.message = message.clone();
    if session.mode == SessionMode::Vod {
        eval_callback(
            app,
            "__tvNativeVideoError",
            vec![
                json!(message),
                json!(session.last_position),
                json!(session.last_duration),
                json!(session.token),
            ],
        );
    } else {
        eval_callback(app, "__tvNativeLiveError", vec![json!(message)]);
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn try_live_fallback(mpv: &libmpv2::Mpv, session: &mut NativeSession) -> bool {
    if session.mode != SessionMode::Live || session.candidate_index + 1 >= session.candidates.len()
    {
        return false;
    }
    session.candidate_index += 1;
    session.ui.event_type = "loading".into();
    session.ui.buffering = true;
    session.ui.message = format!(
        "Trying live fallback {} of {}",
        session.candidate_index,
        session.candidates.len() - 1
    );
    load_session(mpv, session).is_ok()
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn handle_control(
    app: &tauri::AppHandle,
    mpv: &libmpv2::Mpv,
    session: &mut Option<NativeSession>,
    action: ControlAction,
    shared: &Arc<Mutex<PlayerUiState>>,
) -> bool {
    if matches!(action, ControlAction::RequestState) {
        publish_current_ui(app, shared);
        return false;
    }
    if matches!(action, ControlAction::Close) {
        close_session(app, mpv, session, true, shared);
        return false;
    }
    let Some(active) = session.as_mut() else {
        return false;
    };
    match action {
        ControlAction::Play => {
            active.requested_playing = true;
            let _ = mpv.set_property("pause", false);
        }
        ControlAction::Pause => {
            flush_progress(app, Some(active));
            active.requested_playing = false;
            let _ = mpv.set_property("pause", true);
        }
        ControlAction::Toggle => {
            let paused = property::<bool>(mpv, "pause").unwrap_or(false);
            if !paused {
                flush_progress(app, Some(active));
            }
            active.requested_playing = paused;
            let _ = mpv.set_property("pause", !paused);
        }
        ControlAction::SeekAbsolute(target) => request_seek(app, mpv, active, target, false, false),
        ControlAction::SeekRelative(delta) => {
            let target =
                (active.last_position + delta)
                    .max(0.0)
                    .min(if active.last_duration > 0.0 {
                        active.last_duration
                    } else {
                        MAX_PLAYBACK_SECONDS
                    });
            if active.server_seek() {
                request_seek(app, mpv, active, target, false, false);
            } else {
                flush_progress(app, Some(active));
                let delta_string = format!("{delta:.3}");
                let _ = mpv.command("seek", &[delta_string.as_str(), "relative+keyframes"]);
                active.last_position = target;
                active.ui.pos = target;
            }
        }
        ControlAction::Next => eval_callback(
            app,
            "__tvNativeVideoNext",
            vec![
                json!(active.last_position),
                json!(active.last_duration),
                json!(active.token),
            ],
        ),
        ControlAction::Quality(quality) => eval_callback(
            app,
            "__tvNativeVideoQuality",
            vec![
                json!(quality),
                json!(active.last_position),
                json!(active.last_duration),
                json!(active.token),
            ],
        ),
        ControlAction::Episode(index) => eval_callback(
            app,
            "__tvNativeEpisodeSelect",
            vec![
                json!(index),
                json!(active.last_position),
                json!(active.last_duration),
                json!(active.token),
            ],
        ),
        ControlAction::Subtitle(subtitle) => {
            let rel = subtitle.rel.clone();
            if subtitle.url.is_empty() {
                let _ = mpv.set_property("sid", "no");
                active.subtitle = SubtitleRequest {
                    rel: String::new(),
                    url: String::new(),
                    lang: String::new(),
                    label: String::new(),
                    shift: 0.0,
                    size: "M".into(),
                    startup: false,
                };
            } else {
                let _ = apply_subtitle(mpv, &subtitle);
                active.subtitle = subtitle.clone();
            }
            active.ui.subtitle_rel = rel.clone();
            active.ui.subtitle_label = if rel.is_empty() {
                String::new()
            } else {
                subtitle.label
            };
            eval_callback(
                app,
                "__tvNativeSubtitleSelect",
                vec![
                    json!(rel),
                    json!(active.last_position),
                    json!(active.last_duration),
                    json!(active.token),
                ],
            );
        }
        ControlAction::SubtitleShowAll => eval_callback(
            app,
            "__tvNativeSubtitleShowAll",
            vec![
                json!(active.last_position),
                json!(active.last_duration),
                json!(active.token),
            ],
        ),
        ControlAction::SubtitleVersions(lang) => eval_callback(
            app,
            "__tvNativeSubtitleVersions",
            vec![
                json!(lang),
                json!(active.last_position),
                json!(active.last_duration),
                json!(active.token),
            ],
        ),
        ControlAction::SubtitleShift(shift) => {
            let _ = mpv.set_property("sub-delay", shift);
            active.subtitle.shift = shift;
            eval_callback(
                app,
                "__tvNativeSubtitleShift",
                vec![json!(shift), json!(active.token)],
            );
        }
        ControlAction::Audio(id) => {
            if let Ok(track_id) = id.parse::<i64>() {
                match mpv.set_property("aid", track_id) {
                    Ok(()) => {
                        active.ui.audio_id = id;
                        update_audio_tracks(mpv, &mut active.ui);
                    }
                    Err(error) => {
                        active.ui.message = format!("Could not switch audio tracks: {error}")
                    }
                }
            }
        }
        ControlAction::Volume(volume) => {
            let _ = mpv.set_property("volume", volume);
            active.ui.volume = volume;
        }
        ControlAction::Mute(muted) => {
            let _ = mpv.set_property("mute", muted);
            active.ui.muted = muted;
        }
        ControlAction::Retry => {
            active.error_sent = false;
            active.ended = false;
            if let Err(error) = load_session(mpv, active) {
                notify_error(
                    app,
                    active,
                    &format!("native playback retry failed: {error}"),
                );
            }
        }
        ControlAction::ToggleFullscreen => {
            if let Some(window) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
                let fullscreen = window.is_fullscreen().unwrap_or(false);
                let _ = window.set_fullscreen(!fullscreen);
            }
        }
        ControlAction::Minimize => {
            if let Some(window) = app.get_webview_window(PLAYER_WINDOW_LABEL) {
                let _ = window.minimize();
            }
        }
        ControlAction::LiveFavoriteToggle => {
            if active.mode == SessionMode::Live {
                eval_callback(app, "__tvLiveFavToggle", Vec::new());
            }
        }
        ControlAction::LiveZap(direction) => {
            if active.mode == SessionMode::Live {
                eval_callback(app, "__tvNativeLiveZap", vec![json!(direction)]);
            }
        }
        ControlAction::OpenGuide => active.ui.guide = true,
        ControlAction::CloseGuide => active.ui.guide = false,
        ControlAction::Close | ControlAction::RequestState => {}
    }
    publish_ui(app, shared, active.ui.clone());
    false
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn request_seek(
    app: &tauri::AppHandle,
    mpv: &libmpv2::Mpv,
    session: &mut NativeSession,
    target: f64,
    resume: bool,
    percent_resume: bool,
) {
    flush_progress(app, Some(session));
    if session.server_seek() {
        eval_callback(
            app,
            "__tvNativeVideoSeek",
            vec![
                json!(target),
                json!(session.last_duration),
                json!(resume),
                json!(session.token),
                json!(percent_resume),
            ],
        );
    } else {
        let target_string = format!("{target:.3}");
        let _ = mpv.command("seek", &[target_string.as_str(), "absolute+keyframes"]);
        session.last_position = target;
        session.ui.pos = target;
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn handle_update(
    app: &tauri::AppHandle,
    mpv: &libmpv2::Mpv,
    session: Option<&mut NativeSession>,
    update: UpdateAction,
    shared: &Arc<Mutex<PlayerUiState>>,
) {
    let Some(active) = session else { return };
    match update {
        UpdateAction::SubtitleChoices(choices) => active.ui.subtitle_choices = choices,
        UpdateAction::ActiveSubtitle(subtitle) => {
            if apply_subtitle(mpv, &subtitle).is_ok() {
                active.ui.subtitle_rel = subtitle.rel.clone();
                active.ui.subtitle_label = subtitle.label.clone();
                active.subtitle = subtitle;
            }
        }
        UpdateAction::Duration(duration) => {
            active.duration_hint = duration;
            active.last_duration = duration;
            active.ui.duration = duration;
        }
        UpdateAction::EpisodeChoices {
            choices,
            focus_index,
        } => {
            active.ui.episode_choices = choices;
            active.ui.episode_focus_index = focus_index;
        }
        UpdateAction::UpNext(value) => active.ui.up_next = value,
        UpdateAction::UpNextHide => active.ui.up_next = Value::Null,
        UpdateAction::LiveEpg(programs) => active.ui.live_epg = programs,
        UpdateAction::LiveFavorite(on) => active.ui.live_favorite = on,
    }
    publish_ui(app, shared, active.ui.clone());
}

#[cfg(all(feature = "player", target_os = "windows"))]
fn close_session(
    app: &tauri::AppHandle,
    mpv: &libmpv2::Mpv,
    session: &mut Option<NativeSession>,
    notify: bool,
    shared: &Arc<Mutex<PlayerUiState>>,
) {
    if let Some(active) = session.as_mut() {
        flush_progress(app, Some(active));
        if notify {
            if active.mode == SessionMode::Vod {
                eval_callback(
                    app,
                    "__tvNativeVideoClosed",
                    vec![
                        json!(active.last_position),
                        json!(active.last_duration),
                        json!(false),
                        json!(active.token),
                    ],
                );
            } else {
                eval_callback(app, "__tvNativeLiveClosed", Vec::new());
            }
        }
    } else if notify {
        let snapshot = shared.lock().map(|state| state.clone()).unwrap_or_default();
        if snapshot.token > 0 {
            eval_callback(
                app,
                "__tvNativeVideoClosed",
                vec![json!(0), json!(0), json!(false), json!(snapshot.token)],
            );
        }
    }
    let _ = mpv.command("stop", &[]);
    *session = None;
    publish_ui(
        app,
        shared,
        PlayerUiState {
            event_type: "closed".into(),
            ..PlayerUiState::default()
        },
    );
    show_catalog(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> &'static str {
        "https://media.example:8443"
    }

    #[test]
    fn vod_urls_are_same_origin_and_route_limited() {
        assert!(validated_same_origin_url(
            "https://media.example:8443/api/stream/a?t=secret",
            server(),
            vod_path_allowed,
            "video"
        )
        .is_ok());
        assert!(validated_same_origin_url(
            "https://evil.example/api/stream/a?t=secret",
            server(),
            vod_path_allowed,
            "video"
        )
        .is_err());
        assert!(validated_same_origin_url(
            "https://media.example:8443/api/settings",
            server(),
            vod_path_allowed,
            "video"
        )
        .is_err());
    }

    #[test]
    fn native_error_text_redacts_stream_queries() {
        let message = redact_url_query(
            "failed https://media.example/api/stream/a?t=secret&user=private after retry",
        );
        assert_eq!(
            message,
            "failed https://media.example/api/stream/a?[redacted] after retry"
        );
        assert!(!message.contains("secret"));
        assert!(!message.contains("private"));
    }

    #[test]
    #[cfg(all(feature = "player", target_os = "windows"))]
    fn eof_is_accepted_only_after_the_current_file_loaded() {
        let eof = libmpv2::mpv_end_file_reason::Eof;
        assert!(!current_file_eof(false, false, eof));
        assert!(!current_file_eof(true, false, eof));
        assert!(current_file_eof(true, true, eof));
        assert!(!current_file_eof(
            true,
            true,
            libmpv2::mpv_end_file_reason::Stop
        ));
    }

    #[test]
    fn subtitle_routes_are_narrow() {
        for path in [
            "/api/subtitle/m/0?t=x",
            "/api/releasesub/m/en?t=x",
            "/api/ossubs/m?t=x",
        ] {
            assert!(validated_same_origin_url(
                &format!("{}{path}", server()),
                server(),
                subtitle_path_allowed,
                "subtitle"
            )
            .is_ok());
        }
        assert!(validated_same_origin_url(
            &format!("{}/api/me", server()),
            server(),
            subtitle_path_allowed,
            "subtitle"
        )
        .is_err());
    }

    #[test]
    fn live_candidates_reject_private_addresses_and_unsafe_https_dns() {
        assert!(
            validated_live_url("http://169.254.169.254/latest/meta-data", server(), "live")
                .is_err()
        );
        assert!(validated_live_url("http://localhost:9000/channel", server(), "live").is_err());
        assert!(validated_live_url("https://iptv.example/channel.m3u8", server(), "live").is_err());
        let literal =
            validated_live_url("https://93.184.216.34/channel.m3u8", server(), "live").unwrap();
        assert_eq!(literal.connect_url, "https://93.184.216.34/channel.m3u8");
        assert_eq!(literal.host_header, "93.184.216.34");
    }

    #[test]
    fn live_http_dns_is_fully_checked_then_pinned_with_a_safe_host_header() {
        let validated = validated_live_url_with_resolver(
            "http://provider.example:8080/live/channel?token=x",
            server(),
            "live",
            |host, port| {
                assert_eq!(host, "provider.example");
                assert_eq!(port, 8080);
                Ok(vec!["93.184.216.34".parse().unwrap()])
            },
        )
        .unwrap();
        assert_eq!(
            validated.connect_url,
            "http://93.184.216.34:8080/live/channel?token=x"
        );
        assert_eq!(validated.host_header, "provider.example:8080");

        let mixed = validated_live_url_with_resolver(
            "http://provider.example/live",
            server(),
            "live",
            |_, _| {
                Ok(vec![
                    "93.184.216.34".parse().unwrap(),
                    "192.168.1.5".parse().unwrap(),
                ])
            },
        );
        assert!(mixed.is_err());
    }

    #[test]
    fn pinned_live_host_is_forwarded_as_a_file_local_mpv_option() {
        assert_eq!(
            loadfile_options(0.0, "provider.example:8080").as_deref(),
            Some("http-header-fields=Host:provider.example:8080")
        );
        assert_eq!(
            loadfile_options(12.5, "provider.example").as_deref(),
            Some("start=12.500,http-header-fields=Host:provider.example")
        );
        assert!(loadfile_options(0.0, "").is_none());
    }

    #[test]
    fn live_ip_filter_covers_android_private_and_transition_ranges() {
        for address in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "2002::1",
            "2001::1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
        ] {
            assert!(
                external_ip_forbidden(address.parse().unwrap()),
                "{address} should be blocked"
            );
        }
        assert!(!external_ip_forbidden("93.184.216.34".parse().unwrap()));
        assert!(!external_ip_forbidden(
            "2606:4700:4700::1111".parse().unwrap()
        ));
    }

    #[test]
    fn live_request_keeps_a_safe_server_fallback_when_provider_url_is_rejected() {
        let request = validate_live(
            LivePayload {
                title: "Channel".into(),
                source: "Provider".into(),
                url: "http://192.168.1.10/live".into(),
                mime: "video/mp2t".into(),
                fallback_url: format!("{}/api/iptv/channel?t=x", server()),
                fallback_mime: "video/mp4".into(),
                fallbacks: Vec::new(),
                guide: false,
            },
            server(),
        )
        .unwrap();
        assert_eq!(request.candidates.len(), 1);
        assert!(request.candidates[0].url.contains("/api/iptv/channel"));
        assert!(request.candidates[0].host_header.is_empty());
    }

    #[test]
    fn controls_are_typed_and_bounded() {
        assert!(matches!(
            parse_control("seek_relative", json!({"seconds": 30}), Some(server())).unwrap(),
            ControlAction::SeekRelative(value) if value == 30.0
        ));
        assert!(parse_control("seek_relative", json!({"seconds": 99999}), Some(server())).is_err());
        assert!(parse_control("totally_unknown", Value::Null, Some(server())).is_err());
    }

    #[test]
    fn cache_budget_is_bounded() {
        assert_eq!(cache_bytes(0, 0, 0.0, "1080p"), 96 * 1024 * 1024);
        assert_eq!(
            cache_bytes(999, 120 * 1024 * 1024 * 1024, 3600.0, "4K"),
            768 * 1024 * 1024
        );
    }

    #[test]
    fn cache_budget_uses_real_1080p_and_high_bitrate_4k_rates() {
        let ordinary_1080p = cache_bytes(30, 12 * 1024 * 1024 * 1024, 7200.0, "1080p");
        let high_bitrate_4k = cache_bytes(30, 120 * 1024 * 1024 * 1024, 7200.0, "4K HDR");
        assert_eq!(ordinary_1080p, 64 * 1024 * 1024);
        assert_eq!(high_bitrate_4k, 512 * 1024 * 1024);
        assert!(high_bitrate_4k > 30 * 8 * 1024 * 1024);
    }

    #[test]
    fn cache_budget_has_conservative_first_play_fallbacks() {
        assert_eq!(cache_bytes(30, 0, 0.0, "1080p"), 96 * 1024 * 1024);
        assert_eq!(cache_bytes(30, 0, 0.0, "2160p"), 384 * 1024 * 1024);
    }

    #[test]
    fn server_seek_display_time_adds_stream_offset() {
        let request = VodRequest {
            title: "Episode".into(),
            episode_label: String::new(),
            source: String::new(),
            url: format!("{}/api/remux/a?t=x", server()),
            backdrop_url: String::new(),
            start: 0.0,
            start_offset: 120.5,
            kind: "remux".into(),
            quality_label: "4K".into(),
            size: 0,
            duration: 3600.0,
            start_fraction: 0.0,
            buffer_goal_sec: 30,
            token: 7,
            quality_choices: true,
            has_next: true,
            subtitle: SubtitleRequest {
                rel: String::new(),
                url: String::new(),
                lang: String::new(),
                label: String::new(),
                shift: 0.0,
                size: String::new(),
                startup: false,
            },
            subtitle_choices: Vec::new(),
            episode_choices: Vec::new(),
            quiet_seek: false,
            percent_resume: false,
        };
        let session = NativeSession::from_vod(request);
        assert_eq!(session.display_position(4.25), 124.75);
        assert_eq!(session.display_duration(3479.5), 3600.0);
    }
}
