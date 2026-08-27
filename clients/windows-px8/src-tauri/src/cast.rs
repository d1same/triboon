//! Windows Chromecast sender.
//!
//! WebView2 cannot load Google's `cast_sender.js`. This module finds Cast devices
//! with mDNS and talks Cast V2 over TLS, same receiver-pull path as the phone app.

use crate::parse_http_url;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream, UdpSocket};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_RECEIVER_APP_ID: &str = "CC1AD845";
const MDNS_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;
const CAST_NAMESPACE_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const CAST_NAMESPACE_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const CAST_NAMESPACE_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const CAST_NAMESPACE_MEDIA: &str = "urn:x-cast:com.google.cast.media";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CastDevice {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub model: String,
    pub id: String,
}

impl CastDevice {
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "model": self.model,
            "id": self.id,
        })
    }
}

#[derive(Debug, Clone)]
pub struct CastServerHints {
    pub lan_origin: String,
    pub app_id: String,
}

#[derive(Debug, Clone)]
pub struct CastMedia {
    pub url: String,
    pub title: String,
    pub subtitle: String,
    pub current_time: f64,
    pub duration: f64,
}

#[derive(Debug, Clone)]
pub struct CastStatus {
    pub connected: bool,
    pub position: f64,
    pub duration: f64,
    pub state: String,
    pub device: String,
}

impl CastStatus {
    pub fn to_json(&self) -> Value {
        json!({
            "connected": self.connected,
            "position": self.position,
            "duration": self.duration,
            "state": self.state,
            "device": self.device,
        })
    }
}

pub fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]" | "::1"
    )
}

pub fn is_private_cast_host(host: &str) -> bool {
    let Ok(ip) = host.parse::<Ipv4Addr>() else {
        return false;
    };
    ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_broadcast()
}

pub fn valid_cast_port(port: u16) -> bool {
    port >= 1024
}

pub fn valid_lan_origin(raw: &str) -> bool {
    let Ok(parsed) = parse_http_url(&format!("{}/", raw.trim().trim_end_matches('/'))) else {
        return false;
    };
    parsed.scheme == "http" && is_private_cast_host(&parsed.host)
}

pub fn media_url_for_receiver(url: &str, server: &str, lan_origin: &str) -> Result<String, String> {
    let parsed = parse_http_url(url).map_err(|_| "cast URL is invalid".to_string())?;
    let server_parsed =
        parse_http_url(&format!("{}/", server.trim_end_matches('/'))).map_err(|_| {
            "cast server origin is invalid".to_string()
        })?;
    let same_origin = parsed.origin() == server_parsed.origin();
    let loopback_pair = is_loopback_host(&parsed.host)
        && is_loopback_host(&server_parsed.host)
        && parsed.port == server_parsed.port;
    if !same_origin && !loopback_pair {
        return Err("cast URL is outside the configured Triboon server".into());
    }
    let path = parsed
        .path_and_query
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(parsed.path_and_query.as_str());
    if !super::vod_path_allowed(path) {
        return Err("cast URL is not a Triboon media route".into());
    }
    if is_loopback_host(&parsed.host) {
        if !valid_lan_origin(lan_origin) {
            return Err(
                "Open Triboon by its house address (not localhost) so the TV can reach it".into(),
            );
        }
        let lan = parse_http_url(&format!("{}/", lan_origin.trim().trim_end_matches('/')))
            .map_err(|_| "LAN origin is invalid".to_string())?;
        return Ok(format!("{}{}", lan.origin(), parsed.path_and_query));
    }
    Ok(parsed.normalized_url())
}

pub fn with_cast_start(url: &str, start: f64) -> String {
    let start = start.max(0.0);
    let mut base = url.to_string();
    if let Some(idx) = base.find("&start=") {
        base.truncate(idx);
    }
    if let Some(idx) = base.find("?start=") {
        if !base[idx + 1..].contains('&') {
            base.truncate(idx);
        }
    }
    if base.contains('?') {
        format!("{base}&start={start:.3}")
    } else {
        format!("{base}?start={start:.3}")
    }
}

pub fn preferred_cast_source(stream_url: &str, remux_url: &str, transcode_url: &str, position: f64) -> (String, f64) {
    if !remux_url.is_empty() {
        return (with_cast_start(remux_url, position), 0.0);
    }
    if !transcode_url.is_empty() {
        return (with_cast_start(transcode_url, position), 0.0);
    }
    (stream_url.to_string(), position.max(0.0))
}

pub fn cast_server_hints(server: &str) -> CastServerHints {
    let mut hints = CastServerHints {
        lan_origin: String::new(),
        app_id: DEFAULT_RECEIVER_APP_ID.into(),
    };
    if let Ok(parsed) = parse_http_url(&format!("{}/", server.trim_end_matches('/'))) {
        if !is_loopback_host(&parsed.host) && parsed.scheme == "http" && is_private_cast_host(&parsed.host)
        {
            hints.lan_origin = parsed.origin();
        }
    }
    if let Ok(info) = http_get_json(server, "/api/server") {
        if let Some(lan) = info.get("lanOrigin").and_then(Value::as_str) {
            if valid_lan_origin(lan) {
                hints.lan_origin = lan.trim().trim_end_matches('/').to_string();
            }
        }
        if let Some(id) = info.get("castReceiverAppId").and_then(Value::as_str) {
            let id = id.trim().to_ascii_uppercase();
            if id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
                hints.app_id = id;
            }
        }
    }
    hints
}

fn http_get_json(origin: &str, path: &str) -> Result<Value, String> {
    let parsed = parse_http_url(&format!("{}{}", origin.trim_end_matches('/'), path))
        .map_err(|_| "server URL is invalid".to_string())?;
    if parsed.scheme != "http" {
        return Err("native Cast only fetches hints over HTTP".into());
    }
    let connect_host = if parsed.host == "localhost" {
        "127.0.0.1"
    } else {
        parsed.host.trim_start_matches('[').trim_end_matches(']')
    };
    let addr = format!("{connect_host}:{}", parsed.port)
        .parse::<SocketAddr>()
        .or_else(|_| {
            format!("{connect_host}:{}", parsed.port)
                .parse::<SocketAddrV4>()
                .map(SocketAddr::V4)
        })
        .map_err(|_| "server address is invalid".to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("could not reach Triboon: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let host_header = if (parsed.scheme == "http" && parsed.port == 80)
        || (parsed.scheme == "https" && parsed.port == 443)
    {
        parsed.host.clone()
    } else {
        format!("{}:{}", parsed.host, parsed.port)
    };
    let request = format!(
        "GET {} HTTP/1.0\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        parsed.path_and_query, host_header
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .or_else(|| text.split("\n\n").nth(1))
        .ok_or_else(|| "server returned no body".to_string())?;
    serde_json::from_str(body.trim()).map_err(|_| "server JSON is invalid".to_string())
}

const GOOGLECAST_SERVICE: &str = "_googlecast._tcp.local";
const CAST_PORT: u16 = 8009;

fn local_private_ipv4s() -> Vec<Ipv4Addr> {
    let mut ips = HashSet::new();
    // Connecting to each LAN probe picks THAT NIC, even when the default route is VPN/WSL.
    for dest in [
        "8.8.8.8:80",
        "1.1.1.1:80",
        "10.1.20.1:9",
        "10.0.0.1:9",
        "192.168.1.1:9",
        "192.168.0.1:9",
        "192.168.86.1:9",
    ] {
        let Ok(socket) = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(dest).is_err() {
            continue;
        }
        let Ok(SocketAddr::V4(local)) = socket.local_addr() else {
            continue;
        };
        let ip = *local.ip();
        if is_private_cast_host(&ip.to_string()) {
            ips.insert(ip);
        }
    }
    let mut list: Vec<Ipv4Addr> = ips.into_iter().collect();
    list.sort();
    list
}

fn skip_cast_scan_network(ip: Ipv4Addr) -> bool {
    // Hyper-V / WSL 172.x sweeps are slow and never have the living-room TVs.
    ip.octets()[0] == 172
}

fn mdns_query(name: &str, qtype: u16, unicast: bool) -> Vec<u8> {
    let mut out = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in name.split('.') {
        if label.is_empty() {
            continue;
        }
        let bytes = label.as_bytes();
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
    }
    out.push(0);
    out.extend_from_slice(&qtype.to_be_bytes());
    let class = if unicast { 0x8001u16 } else { 0x0001 };
    out.extend_from_slice(&class.to_be_bytes());
    out
}

fn mdns_ptr_query(name: &str) -> Vec<u8> {
    mdns_query(name, 12, false)
}

fn bind_mdns_socket(addr: SocketAddrV4, iface: Option<Ipv4Addr>) -> Option<UdpSocket> {
    let socket = UdpSocket::bind(addr).ok()?;
    let _ = socket.set_read_timeout(Some(Duration::from_millis(50)));
    let _ = socket.set_multicast_ttl_v4(255);
    let _ = socket.set_multicast_loop_v4(true);
    if let Some(ip) = iface {
        let _ = socket.join_multicast_v4(&MDNS_ADDR, &ip);
    }
    Some(socket)
}

fn open_mdns_sockets(ifaces: &[Ipv4Addr]) -> Vec<UdpSocket> {
    let mut sockets = Vec::new();
    if let Some(listener) = bind_mdns_socket(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT), None)
    {
        for ip in ifaces {
            let _ = listener.join_multicast_v4(&MDNS_ADDR, ip);
        }
        sockets.push(listener);
    }
    for ip in ifaces {
        if let Some(socket) = bind_mdns_socket(SocketAddrV4::new(*ip, 0), Some(*ip)) {
            sockets.push(socket);
        }
    }
    if let Some(socket) = bind_mdns_socket(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0), None) {
        sockets.push(socket);
    }
    sockets
}

fn send_mdns_queries(sockets: &[UdpSocket], store: &MdnsRecords, asked_srv: &mut HashSet<String>, asked_a: &mut HashSet<String>) {
    let dest = SocketAddr::from((MDNS_ADDR, MDNS_PORT));
    let ptr_qm = mdns_query(GOOGLECAST_SERVICE, 12, false);
    let ptr_qu = mdns_query(GOOGLECAST_SERVICE, 12, true);
    for socket in sockets {
        let _ = socket.send_to(&ptr_qu, dest);
        let _ = socket.send_to(&ptr_qm, dest);
    }
    let mut want_srv = Vec::new();
    for instance in store.ptrs.values() {
        let key = instance.to_ascii_lowercase();
        if !store.srvs.contains_key(&key) && asked_srv.insert(key.clone()) {
            want_srv.push(instance.clone());
        }
    }
    for instance in want_srv {
        let qu = mdns_query(&instance, 33, true);
        let qm = mdns_query(&instance, 33, false);
        for socket in sockets {
            let _ = socket.send_to(&qu, dest);
            let _ = socket.send_to(&qm, dest);
        }
    }
    let mut want_a = Vec::new();
    for (port, target) in store.srvs.values() {
        let _ = port;
        let key = target.to_ascii_lowercase();
        if !store.addrs.contains_key(&key) && asked_a.insert(key.clone()) {
            want_a.push(target.clone());
        }
    }
    for host in want_a {
        let qu = mdns_query(&host, 1, true);
        let qm = mdns_query(&host, 1, false);
        for socket in sockets {
            let _ = socket.send_to(&qu, dest);
            let _ = socket.send_to(&qm, dest);
        }
    }
}

fn recv_mdns(sockets: &[UdpSocket], store: &mut MdnsRecords) {
    let mut buf = [0u8; 2048];
    for socket in sockets {
        while let Ok((len, _)) = socket.recv_from(&mut buf) {
            ingest_mdns(store, &buf[..len]);
        }
    }
}

fn scan_cast_port_8009(ifaces: &[Ipv4Addr], budget: Duration) -> Vec<CastDevice> {
    if budget < Duration::from_millis(200) {
        return Vec::new();
    }
    let mut nets = HashSet::new();
    let own: HashSet<Ipv4Addr> = ifaces.iter().copied().collect();
    for ip in ifaces {
        if skip_cast_scan_network(*ip) {
            continue;
        }
        let oct = ip.octets();
        nets.insert((oct[0], oct[1], oct[2]));
    }
    let mut hosts = Vec::new();
    for (a, b, c) in nets {
        for host in 1..=254u8 {
            let ip = Ipv4Addr::new(a, b, c, host);
            if !own.contains(&ip) {
                hosts.push(ip);
            }
        }
    }
    let (tx, rx) = mpsc::channel();
    let deadline = Instant::now() + budget;
    let workers = 24.min(hosts.len().max(1));
    let chunk = (hosts.len() + workers - 1) / workers;
    for piece in hosts.chunks(chunk.max(1)) {
        let piece = piece.to_vec();
        let tx = tx.clone();
        thread::spawn(move || {
            for ip in piece {
                if Instant::now() >= deadline {
                    break;
                }
                let addr = SocketAddr::from((ip, CAST_PORT));
                if TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok() {
                    let host = ip.to_string();
                    let _ = tx.send(CastDevice {
                        name: format!("TV at {host}"),
                        host: host.clone(),
                        port: CAST_PORT,
                        model: "Chromecast".into(),
                        id: host,
                    });
                }
            }
        });
    }
    drop(tx);
    let mut devices = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(device) => devices.push(device),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    devices
}

pub fn discover(timeout: Duration) -> Vec<CastDevice> {
    let ifaces = local_private_ipv4s();
    let sockets = open_mdns_sockets(&ifaces);
    let mut store = MdnsRecords::default();
    if !sockets.is_empty() {
        let mdns_budget = timeout.saturating_sub(Duration::from_millis(800)).max(Duration::from_millis(900));
        let deadline = Instant::now() + mdns_budget;
        let mut next_query = Instant::now();
        let mut asked_srv = HashSet::new();
        let mut asked_a = HashSet::new();
        let mut first_hit: Option<Instant> = None;
        while Instant::now() < deadline {
            if Instant::now() >= next_query {
                send_mdns_queries(&sockets, &store, &mut asked_srv, &mut asked_a);
                next_query = Instant::now() + Duration::from_millis(350);
            }
            recv_mdns(&sockets, &mut store);
            if !devices_from_mdns(&store).is_empty() {
                let hit = *first_hit.get_or_insert_with(Instant::now);
                if Instant::now().saturating_duration_since(hit) >= Duration::from_millis(250) {
                    break;
                }
            }
        }
        recv_mdns(&sockets, &mut store);
    }
    let mut by_id: HashMap<String, CastDevice> = HashMap::new();
    for device in devices_from_mdns(&store) {
        by_id.insert(device.id.clone(), device);
    }
    if by_id.is_empty() {
        let remain = timeout / 3;
        for device in scan_cast_port_8009(&ifaces, remain.max(Duration::from_millis(600))) {
            by_id.entry(device.id.clone()).or_insert(device);
        }
    }
    let mut list: Vec<CastDevice> = by_id.into_values().collect();
    list.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    list
}

#[derive(Default)]
struct MdnsRecords {
    ptrs: HashMap<String, String>,
    srvs: HashMap<String, (u16, String)>,
    txts: HashMap<String, HashMap<String, String>>,
    addrs: HashMap<String, String>,
}

fn ingest_mdns(store: &mut MdnsRecords, packet: &[u8]) {
    if packet.len() < 12 {
        return;
    }
    let ancount = u16::from_be_bytes([packet[6], packet[7]]) as usize;
    let nscount = u16::from_be_bytes([packet[8], packet[9]]) as usize;
    let arcount = u16::from_be_bytes([packet[10], packet[11]]) as usize;
    let qdcount = u16::from_be_bytes([packet[4], packet[5]]) as usize;
    let mut offset = 12;
    for _ in 0..qdcount {
        let Ok((_, next)) = read_dns_name(packet, offset, 0) else {
            return;
        };
        offset = next.saturating_add(4);
        if offset > packet.len() {
            return;
        }
    }
    for _ in 0..(ancount + nscount + arcount) {
        let Ok((name, next)) = read_dns_name(packet, offset, 0) else {
            break;
        };
        if next + 10 > packet.len() {
            break;
        }
        let rtype = u16::from_be_bytes([packet[next], packet[next + 1]]);
        let rdlen = u16::from_be_bytes([packet[next + 8], packet[next + 9]]) as usize;
        let rdata_at = next + 10;
        let after = rdata_at.saturating_add(rdlen);
        if after > packet.len() {
            break;
        }
        let rdata = &packet[rdata_at..after];
        match rtype {
            12 => {
                if let Ok((target, _)) = read_dns_name(packet, rdata_at, 0) {
                    store.ptrs.insert(name.to_ascii_lowercase(), target);
                }
            }
            33 if rdata.len() >= 6 => {
                let port = u16::from_be_bytes([rdata[4], rdata[5]]);
                if let Ok((target, _)) = read_dns_name(packet, rdata_at + 6, 0) {
                    store.srvs.insert(name.to_ascii_lowercase(), (port, target));
                }
            }
            16 => {
                store.txts.insert(name.to_ascii_lowercase(), parse_txt(rdata));
            }
            1 if rdata.len() == 4 => {
                let ip = Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]);
                if is_private_cast_host(&ip.to_string()) {
                    store.addrs.insert(name.to_ascii_lowercase(), ip.to_string());
                }
            }
            _ => {}
        }
        offset = after;
    }
}

fn devices_from_mdns(store: &MdnsRecords) -> Vec<CastDevice> {
    let mut instances: HashSet<String> = store.ptrs.values().cloned().collect();
    for name in store.srvs.keys() {
        if name.contains("_googlecast._tcp") {
            instances.insert(name.clone());
        }
    }
    let mut devices = Vec::new();
    for instance in instances {
        let key = instance.to_ascii_lowercase();
        let Some((port, target)) = store.srvs.get(&key).cloned() else {
            continue;
        };
        if !valid_cast_port(port) {
            continue;
        }
        let host = store
            .addrs
            .get(&target.to_ascii_lowercase())
            .cloned()
            .or_else(|| store.addrs.get(&key).cloned());
        let Some(host) = host else {
            continue;
        };
        let txt = store.txts.get(&key).cloned().unwrap_or_default();
        let name = txt
            .get("fn")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("TV")
            .chars()
            .take(80)
            .collect::<String>();
        let model = txt
            .get("md")
            .map(|value| value.trim())
            .unwrap_or("Chromecast")
            .chars()
            .take(40)
            .collect::<String>();
        let id = txt
            .get("id")
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or_else(|| format!("{host}:{port}"));
        devices.push(CastDevice {
            name,
            host,
            port,
            model,
            id: id.chars().take(64).collect(),
        });
    }
    devices
}

fn parse_mdns_googlecast(packet: &[u8]) -> Vec<CastDevice> {
    let mut store = MdnsRecords::default();
    ingest_mdns(&mut store, packet);
    devices_from_mdns(&store)
}

fn parse_txt(rdata: &[u8]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut offset = 0;
    while offset < rdata.len() {
        let len = rdata[offset] as usize;
        offset += 1;
        if len == 0 || offset + len > rdata.len() {
            break;
        }
        let chunk = String::from_utf8_lossy(&rdata[offset..offset + len]);
        if let Some((key, value)) = chunk.split_once('=') {
            map.insert(key.to_ascii_lowercase(), value.to_string());
        }
        offset += len;
    }
    map
}

fn read_dns_name(packet: &[u8], mut offset: usize, jumps: u8) -> Result<(String, usize), ()> {
    if jumps > 10 || offset >= packet.len() {
        return Err(());
    }
    let mut labels = Vec::new();
    let mut end = offset;
    let jumped = false;
    loop {
        if offset >= packet.len() {
            return Err(());
        }
        let len = packet[offset];
        if len == 0 {
            offset += 1;
            if !jumped {
                end = offset;
            }
            break;
        }
        if len & 0xC0 == 0xC0 {
            if offset + 1 >= packet.len() {
                return Err(());
            }
            let pointer = (((len as usize) & 0x3F) << 8) | packet[offset + 1] as usize;
            if !jumped {
                end = offset + 2;
            }
            let (rest, _) = read_dns_name(packet, pointer, jumps + 1)?;
            if !rest.is_empty() {
                labels.push(rest);
            }
            break;
        }
        if len & 0xC0 != 0 {
            return Err(());
        }
        offset += 1;
        let end_label = offset + len as usize;
        if end_label > packet.len() {
            return Err(());
        }
        labels.push(String::from_utf8_lossy(&packet[offset..end_label]).into_owned());
        offset = end_label;
        if !jumped {
            end = offset;
        }
    }
    Ok((labels.join("."), end))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CastMessage {
    source_id: String,
    destination_id: String,
    namespace: String,
    payload: String,
}

fn encode_varint(mut value: u32, out: &mut Vec<u8>) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn encode_key(field: u32, wire: u32, out: &mut Vec<u8>) {
    encode_varint((field << 3) | wire, out);
}

fn encode_string_field(field: u32, value: &str, out: &mut Vec<u8>) {
    encode_key(field, 2, out);
    encode_varint(value.len() as u32, out);
    out.extend_from_slice(value.as_bytes());
}

fn encode_cast_message(message: &CastMessage) -> Vec<u8> {
    let mut out = Vec::new();
    encode_key(1, 0, &mut out);
    encode_varint(0, &mut out);
    encode_string_field(2, &message.source_id, &mut out);
    encode_string_field(3, &message.destination_id, &mut out);
    encode_string_field(4, &message.namespace, &mut out);
    encode_key(5, 0, &mut out);
    encode_varint(0, &mut out);
    encode_string_field(6, &message.payload, &mut out);
    out
}

fn decode_varint(buf: &[u8], offset: &mut usize) -> Result<u32, ()> {
    let mut result = 0u32;
    let mut shift = 0;
    loop {
        if *offset >= buf.len() || shift > 28 {
            return Err(());
        }
        let byte = buf[*offset];
        *offset += 1;
        result |= u32::from(byte & 0x7F) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
    }
}

fn decode_cast_message(buf: &[u8]) -> Result<CastMessage, String> {
    let mut offset = 0;
    let mut source_id = String::new();
    let mut destination_id = String::new();
    let mut namespace = String::new();
    let mut payload = String::new();
    while offset < buf.len() {
        let tag = decode_varint(buf, &mut offset).map_err(|_| "cast frame is invalid")?;
        let field = tag >> 3;
        let wire = tag & 7;
        match (field, wire) {
            (2 | 3 | 4 | 6, 2) => {
                let len = decode_varint(buf, &mut offset).map_err(|_| "cast frame is invalid")?
                    as usize;
                if offset + len > buf.len() {
                    return Err("cast frame is invalid".into());
                }
                let text = String::from_utf8_lossy(&buf[offset..offset + len]).into_owned();
                offset += len;
                match field {
                    2 => source_id = text,
                    3 => destination_id = text,
                    4 => namespace = text,
                    6 => payload = text,
                    _ => {}
                }
            }
            (_, 0) => {
                let _ = decode_varint(buf, &mut offset).map_err(|_| "cast frame is invalid")?;
            }
            (_, 2) => {
                let len = decode_varint(buf, &mut offset).map_err(|_| "cast frame is invalid")?
                    as usize;
                offset = offset.saturating_add(len);
            }
            _ => break,
        }
    }
    Ok(CastMessage {
        source_id,
        destination_id,
        namespace,
        payload,
    })
}

#[cfg(all(feature = "player", target_os = "windows"))]
mod session {
    use super::*;
    use native_tls::TlsConnector;
    use std::net::ToSocketAddrs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    pub fn run_session(
        host: &str,
        port: u16,
        name: &str,
        media: &CastMedia,
        app_id: &str,
        stop: Arc<AtomicBool>,
        mut on_status: impl FnMut(CastStatus),
    ) -> Result<(), String> {
        if !is_private_cast_host(host) || !valid_cast_port(port) {
            return Err("that TV address is not allowed".into());
        }
        let addr = (host, port)
            .to_socket_addrs()
            .map_err(|e| e.to_string())?
            .next()
            .ok_or_else(|| "could not reach that TV".to_string())?;
        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
            .map_err(|e| format!("could not reach {name}: {e}"))?;
        tcp.set_nodelay(true).map_err(|e| e.to_string())?;
        tcp.set_read_timeout(Some(Duration::from_secs(8)))
            .map_err(|e| e.to_string())?;
        tcp.set_write_timeout(Some(Duration::from_secs(8)))
            .map_err(|e| e.to_string())?;
        let connector = TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(|e| e.to_string())?;
        let mut tls = connector
            .connect(host, tcp)
            .map_err(|e| format!("TV TLS failed: {e}"))?;
        let mut request_id = 1u32;
        write_json(
            &mut tls,
            "sender-0",
            "receiver-0",
            CAST_NAMESPACE_CONNECTION,
            json!({"type":"CONNECT"}),
        )?;
        write_json(
            &mut tls,
            "sender-0",
            "receiver-0",
            CAST_NAMESPACE_RECEIVER,
            json!({"type":"GET_STATUS","requestId": request_id}),
        )?;
        request_id += 1;
        let mut transport = wait_for_transport(&mut tls, app_id, Duration::from_secs(4))?;
        if transport.is_empty() {
            write_json(
                &mut tls,
                "sender-0",
                "receiver-0",
                CAST_NAMESPACE_RECEIVER,
                json!({"type":"LAUNCH","appId": app_id, "requestId": request_id}),
            )?;
            request_id += 1;
            transport = wait_for_transport(&mut tls, app_id, Duration::from_secs(10))?;
        }
        if transport.is_empty() {
            return Err(format!("{name} did not start the Cast receiver"));
        }
        write_json(
            &mut tls,
            "sender-0",
            &transport,
            CAST_NAMESPACE_CONNECTION,
            json!({"type":"CONNECT"}),
        )?;
        write_json(
            &mut tls,
            "sender-0",
            &transport,
            CAST_NAMESPACE_MEDIA,
            json!({
                "type": "LOAD",
                "requestId": request_id,
                "autoplay": true,
                "currentTime": media.current_time.max(0.0),
                "media": {
                    "contentId": media.url,
                    "contentType": "video/mp4",
                    "streamType": "BUFFERED",
                    "metadata": {
                        "metadataType": 0,
                        "title": media.title,
                        "subtitle": media.subtitle,
                    }
                }
            }),
        )?;
        let loaded = wait_for_media(&mut tls, Duration::from_secs(12))?;
        on_status(CastStatus {
            connected: true,
            position: if loaded.0 > 0.0 {
                loaded.0
            } else {
                media.current_time
            },
            duration: if loaded.1 > 0.0 {
                loaded.1
            } else {
                media.duration
            },
            state: "playing".into(),
            device: name.to_string(),
        });
        let mut last_ping = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            if last_ping.elapsed() >= Duration::from_secs(5) {
                let _ = write_json(
                    &mut tls,
                    "sender-0",
                    "receiver-0",
                    CAST_NAMESPACE_HEARTBEAT,
                    json!({"type":"PING"}),
                );
                last_ping = Instant::now();
            }
            match read_message(&mut tls) {
                Ok(message) => {
                    if message.namespace == CAST_NAMESPACE_HEARTBEAT
                        && message.payload.contains("PING")
                    {
                        let _ = write_json(
                            &mut tls,
                            "sender-0",
                            "receiver-0",
                            CAST_NAMESPACE_HEARTBEAT,
                            json!({"type":"PONG"}),
                        );
                    }
                    if let Some((position, duration, state)) = parse_media_status(&message.payload) {
                        if state == "idle" && duration > 0.0 && position >= duration - 3.0 {
                            on_status(CastStatus {
                                connected: false,
                                position,
                                duration,
                                state,
                                device: name.to_string(),
                            });
                            break;
                        }
                        on_status(CastStatus {
                            connected: true,
                            position,
                            duration,
                            state,
                            device: name.to_string(),
                        });
                    }
                }
                Err(_) => {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                }
            }
        }
        let _ = write_json(
            &mut tls,
            "sender-0",
            "receiver-0",
            CAST_NAMESPACE_CONNECTION,
            json!({"type":"CLOSE"}),
        );
        Ok(())
    }

    fn write_json<S: Write>(
        stream: &mut S,
        source: &str,
        dest: &str,
        namespace: &str,
        payload: Value,
    ) -> Result<(), String> {
        write_message(
            stream,
            &CastMessage {
                source_id: source.into(),
                destination_id: dest.into(),
                namespace: namespace.into(),
                payload: payload.to_string(),
            },
        )
    }

    fn write_message<S: Write>(stream: &mut S, message: &CastMessage) -> Result<(), String> {
        let payload = encode_cast_message(message);
        let len = u32::try_from(payload.len()).map_err(|_| "cast frame is too large")?;
        stream
            .write_all(&len.to_be_bytes())
            .map_err(|e| e.to_string())?;
        stream.write_all(&payload).map_err(|e| e.to_string())?;
        stream.flush().map_err(|e| e.to_string())
    }

    fn read_message<S: Read>(stream: &mut S) -> Result<CastMessage, String> {
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).map_err(|e| e.to_string())?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > 1024 * 1024 {
            return Err("cast frame is invalid".into());
        }
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
        decode_cast_message(&buf)
    }

    fn wait_for_transport<S: Read + Write>(
        stream: &mut S,
        app_id: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match read_message(stream) {
                Ok(message) => {
                    if message.namespace == CAST_NAMESPACE_HEARTBEAT
                        && message.payload.contains("PING")
                    {
                        let _ = write_json(
                            stream,
                            "sender-0",
                            "receiver-0",
                            CAST_NAMESPACE_HEARTBEAT,
                            json!({"type":"PONG"}),
                        );
                    }
                    if let Some(transport) = transport_from_status(&message.payload, app_id) {
                        return Ok(transport);
                    }
                }
                Err(_) => {}
            }
        }
        Ok(String::new())
    }

    fn wait_for_media<S: Read + Write>(
        stream: &mut S,
        timeout: Duration,
    ) -> Result<(f64, f64), String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match read_message(stream) {
                Ok(message) => {
                    if message.namespace == CAST_NAMESPACE_HEARTBEAT
                        && message.payload.contains("PING")
                    {
                        let _ = write_json(
                            stream,
                            "sender-0",
                            "receiver-0",
                            CAST_NAMESPACE_HEARTBEAT,
                            json!({"type":"PONG"}),
                        );
                    }
                    if message.payload.contains("LOAD_FAILED")
                        || message.payload.contains("INVALID_REQUEST")
                    {
                        return Err("the TV could not load this title".into());
                    }
                    if let Some((position, duration, state)) = parse_media_status(&message.payload)
                    {
                        if state != "idle" {
                            return Ok((position, duration));
                        }
                    }
                    if message.payload.contains("MEDIA_STATUS") {
                        return Ok((0.0, 0.0));
                    }
                }
                Err(_) => {}
            }
        }
        Err("the TV did not start the movie".into())
    }

    fn transport_from_status(payload: &str, app_id: &str) -> Option<String> {
        let value: Value = serde_json::from_str(payload).ok()?;
        let apps = value
            .pointer("/status/applications")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let match_app = |app: &Value| {
            let id = app.get("appId").and_then(Value::as_str).unwrap_or_default();
            app_id.is_empty() || id.eq_ignore_ascii_case(app_id) || id == DEFAULT_RECEIVER_APP_ID
        };
        apps.iter()
            .find(|app| match_app(app))
            .and_then(|app| app.get("transportId").and_then(Value::as_str))
            .map(|value| value.to_string())
    }

    fn parse_media_status(payload: &str) -> Option<(f64, f64, String)> {
        let value: Value = serde_json::from_str(payload).ok()?;
        let status = value
            .get("status")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .cloned()
            .or_else(|| value.get("status").cloned())?;
        let position = status
            .get("currentTime")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let duration = status
            .pointer("/media/duration")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let state = status
            .get("playerState")
            .and_then(Value::as_str)
            .unwrap_or("playing")
            .to_ascii_lowercase();
        if value.get("type").and_then(Value::as_str) == Some("MEDIA_STATUS")
            || status.get("playerState").is_some()
        {
            Some((position, duration, state))
        } else {
            None
        }
    }
}

#[cfg(all(feature = "player", target_os = "windows"))]
pub use session::run_session;

#[cfg(test)]
mod tests {
    use super::*;

    use std::net::Ipv4Addr;

    #[test]
    fn loopback_media_is_rewritten_to_the_house_lan() {
        let url = media_url_for_receiver(
            "http://127.0.0.1:7777/api/stream/abc?t=secret",
            "http://127.0.0.1:7777",
            "http://10.1.20.120:7777",
        )
        .unwrap();
        assert_eq!(url, "http://10.1.20.120:7777/api/stream/abc?t=secret");
    }

    #[test]
    fn cast_prefers_remux_over_the_raw_file() {
        let (url, time) = preferred_cast_source(
            "http://10.1.20.120:7777/api/stream/abc?t=secret",
            "http://10.1.20.120:7777/api/remux/abc?t=secret",
            "",
            669.0,
        );
        assert_eq!(url, "http://10.1.20.120:7777/api/remux/abc?t=secret&start=669.000");
        assert_eq!(time, 0.0);
    }

    #[test]
    fn house_server_urls_are_left_alone() {
        let url = media_url_for_receiver(
            "http://10.1.20.120:7777/api/remux/abc?t=secret",
            "http://10.1.20.120:7777",
            "",
        )
        .unwrap();
        assert_eq!(url, "http://10.1.20.120:7777/api/remux/abc?t=secret");
    }

    #[test]
    fn foreign_urls_never_go_to_the_tv() {
        assert!(media_url_for_receiver(
            "http://evil.example/api/stream/abc?t=secret",
            "http://10.1.20.120:7777",
            "http://10.1.20.120:7777",
        )
        .is_err());
        assert!(media_url_for_receiver(
            "http://10.1.20.120:7777/api/settings",
            "http://10.1.20.120:7777",
            "http://10.1.20.120:7777",
        )
        .is_err());
    }

    #[test]
    fn private_cast_hosts_are_lan_only() {
        assert!(is_private_cast_host("192.168.1.40"));
        assert!(is_private_cast_host("10.1.20.11"));
        assert!(!is_private_cast_host("127.0.0.1"));
        assert!(!is_private_cast_host("8.8.8.8"));
        assert!(!is_private_cast_host("living-room.local"));
    }

    #[test]
    fn cast_messages_round_trip() {
        let message = CastMessage {
            source_id: "sender-0".into(),
            destination_id: "receiver-0".into(),
            namespace: CAST_NAMESPACE_RECEIVER.into(),
            payload: "{\"type\":\"GET_STATUS\"}".into(),
        };
        let decoded = decode_cast_message(&encode_cast_message(&message)).unwrap();
        assert_eq!(decoded, message);
    }

    #[test]
    fn mdns_query_asks_for_google_cast() {
        let query = mdns_ptr_query("_googlecast._tcp.local");
        assert!(query.windows(11).any(|window| window == b"_googlecast"));
        assert_eq!(&query[query.len() - 4..], &[0, 12, 0, 1]);
        let qu = mdns_query("_googlecast._tcp.local", 12, true);
        assert_eq!(&qu[qu.len() - 4..], &[0, 12, 0x80, 1]);
    }

    #[test]
    fn mdns_srv_without_ptr_still_makes_a_device() {
        // One packet with SRV + A only — no PTR. Living-room stacks often split those.
        let mut store = super::MdnsRecords::default();
        store.srvs.insert(
            "livingroom._googlecast._tcp.local".into(),
            (8009, "livingroom.local".into()),
        );
        store.addrs.insert("livingroom.local".into(), "10.1.20.40".into());
        store
            .txts
            .entry("livingroom._googlecast._tcp.local".into())
            .or_default()
            .insert("fn".into(), "Living Room".into());
        let devices = super::devices_from_mdns(&store);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Living Room");
        assert_eq!(devices[0].host, "10.1.20.40");
        assert_eq!(devices[0].port, 8009);
        assert!(super::parse_mdns_googlecast(&[]).is_empty());
    }

    #[test]
    fn wsl_subnets_are_not_port_scanned() {
        assert!(super::skip_cast_scan_network(Ipv4Addr::new(172, 24, 16, 1)));
        assert!(!super::skip_cast_scan_network(Ipv4Addr::new(10, 1, 20, 120)));
    }
}
