'use strict';
// Jellyfin app door. Off unless settings.jellyfinApps is exactly true.
// Apps sign in with a Triboon name. Movies and episodes come from the catalog.
// Opening a movie or episode starts the same file search the website starts
// on the details page, so Play can join it. Browsing a row does not.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { AsyncLocalStorage } = require('node:async_hooks');
const debug = require('./debug');

// Phone and TV apps accept a Jellyfin version with three numbers.
// "12.1" has two numbers, so they say the server is unsupported.
const SERVER_VERSION = '10.11.11';
// 480, 576, 720, 1080, 2160. Jellyfin stops at 1080.
const JELLYFIN_MAX_RANK = 3;

const PREFIXES = [
  '/system', '/users', '/useritems', '/userviews', '/items', '/library', '/shows',
  '/displaypreferences', '/quickconnect', '/branding', '/sessions',
  '/plugins', '/startup', '/localization', '/videos', '/livetv', '/playback',
  '/mediasegments', '/socket', '/search',
];

let deps = null;
// These stay closed. Emby apps are not a door on this server.
let embyDoorOpen = () => false;
let embySocketOpen = () => false;
const doorStore = new AsyncLocalStorage();

function bindJellyfin(next) { deps = next; }

function setEmbyDoorCheck(fn) { embyDoorOpen = typeof fn === 'function' ? fn : () => false; }

function setEmbySocketCheck(fn) { embySocketOpen = typeof fn === 'function' ? fn : () => false; }

function jellyfinEnabled(settings) {
  return !!(settings && settings.jellyfinApps === true);
}

function isJellyfinPath(pathname) {
  const p = String(pathname || '').toLowerCase();
  return PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));
}

function serverId(secret) {
  return crypto.createHash('sha256').update(`triboon-jellyfin-id:${String(secret || '')}`).digest('hex').slice(0, 32);
}

function doorServerId() {
  const ctx = doorStore.getStore();
  const salt = ctx && ctx.brand && ctx.brand.idSalt;
  const secret = deps && deps.auth ? deps.auth.secret : '';
  if (salt) return crypto.createHash('sha256').update(`${salt}:${String(secret || '')}`).digest('hex').slice(0, 32);
  return serverId(secret);
}

function jellyfinToken(req) {
  const direct = req.headers['x-emby-token'];
  if (direct) return String(direct).trim();
  const h = String(req.headers.authorization || req.headers['x-emby-authorization'] || '');
  const tok = h.match(/(?:^|[,\s])Token=(?:"([^"]+)"|([^,\s"]+))/i);
  if (tok) return tok[1] || tok[2];
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  try {
    const key = new URL(req.url || '/', 'http://x').searchParams.get('api_key')
      || new URL(req.url || '/', 'http://x').searchParams.get('ApiKey');
    if (key) return String(key).trim();
  } catch {}
  return null;
}

// The TV app refuses the sign-in code unless these four names come back.
// An empty name is fine. A missing name makes Quick Connect look dead.
function authQuoted(ctx, name) {
  const hdr = (ctx && ctx.req && ctx.req.headers) || {};
  const blob = `${hdr.authorization || ''} ${hdr['x-emby-authorization'] || ''}`;
  const match = blob.match(new RegExp('(?:^|[,\\s])' + name + '="([^"]*)"', 'i'));
  return match ? match[1] : '';
}

const CORS_HEADERS = 'Authorization, Content-Type, X-Emby-Token, X-Emby-Authorization, X-Emby-Client, '
  + 'X-Emby-Device-Name, X-Emby-Device-Id, X-Emby-Client-Version, X-MediaBrowser-Token';

// The web player on Samsung and LG unhearts a movie with DELETE. A preflight
// without DELETE in the list makes the heart button do nothing.
function jellyfinCors(req) {
  const asked = String((req && req.headers && req.headers['access-control-request-headers']) || '').trim();
  const reflect = asked && asked.length <= 1024 && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(\s*,\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/.test(asked);
  const out = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers': reflect ? asked : CORS_HEADERS,
  };
  if (reflect) out.vary = 'Access-Control-Request-Headers';
  return out;
}

function emptyPage() {
  return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
}

function firstHeader(value) {
  return String(value || '').split(',')[0].trim();
}

function hostName(host) {
  return String(host || '').split(':')[0].replace(/^\[|\]$/g, '');
}
function hostPort(host) {
  const s = String(host || '');
  const i = s.lastIndexOf(':');
  if (i < 0) return '';
  const port = s.slice(i + 1);
  return /^\d+$/.test(port) ? port : '';
}
// 10.1.20.120 is the house. 172.17 and 172.18 are the usual Docker bridge,
// which a phone cannot open. 127.0.0.1 is the public site's proxy, which
// still has to follow the https name in front of it.
function isDockerBridge(host) {
  return /^172\.(17|18)\.\d{1,3}\.\d{1,3}$/.test(hostName(host));
}
function isLoopback(host) {
  const name = hostName(host).toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}
function isLanHost(host) {
  const name = hostName(host);
  if (!name || isDockerBridge(name) || isLoopback(name)) return false;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(name);
}
// A phone told to open 127.0.0.1 plays the movie on itself and gives up.
// Use a real LAN address on this machine, with the same port. Look up the
// address once; repeating it during shutdown crashes Node on Windows.
let lanHostIp;
function machineLanHost(port) {
  if (lanHostIp === undefined) {
    let preferred = '';
    let other = '';
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list || []) {
        const v4 = addr.family === 'IPv4' || addr.family === 4;
        if (!v4 || addr.internal) continue;
        if (!isLanHost(addr.address)) continue;
        if (addr.address.startsWith('10.') || addr.address.startsWith('192.168.')) preferred = preferred || addr.address;
        else other = other || addr.address;
      }
    }
    lanHostIp = preferred || other || '';
  }
  if (!lanHostIp) return '';
  return port ? `${lanHostIp}:${port}` : lanHostIp;
}

// The address the app should keep using. A phone that opened the house IP
// keeps pictures and the movie on that IP. Behind Unraid, Caddy, or any
// proxy, the public https name wins. A direct house connection stays http.
function clientAddress(ctx) {
  const hdr = (ctx.req && ctx.req.headers) || {};
  const rawHost = firstHeader(hdr.host);
  if (isLanHost(rawHost)) return `http://${rawHost}`;
  let proto = firstHeader(hdr['x-forwarded-proto']).toLowerCase();
  if (proto !== 'https' && proto !== 'http') {
    const match = firstHeader(hdr.forwarded).match(/proto=(https?)/i);
    proto = match ? match[1].toLowerCase() : 'http';
  }
  let host = firstHeader(hdr['x-forwarded-host']) || rawHost || 'localhost';
  if (!firstHeader(hdr['x-forwarded-host']) && (isLoopback(host) || isDockerBridge(host))) {
    const lan = machineLanHost(hostPort(rawHost) || hostPort(host));
    if (lan) {
      host = lan;
      proto = 'http';
    }
  }
  return `${proto}://${host}`;
}

function jellyfinServerName() {
  const s = deps.settings && deps.settings.get ? deps.settings.get() : {};
  const name = String(s.jellyfinServerName || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  return name || 'Triboon';
}

function jellyfinQuickConnectOn() {
  const s = deps.settings && deps.settings.get ? deps.settings.get() : {};
  return s.jellyfinQuickConnect !== false;
}

function publicInfo(ctx) {
  const brand = ctx && ctx.brand;
  let address = clientAddress(ctx);
  if (brand && brand.addressSuffix) address += brand.addressSuffix;
  return {
    LocalAddress: address,
    ServerName: brand && brand.serverName ? brand.serverName : jellyfinServerName(),
    Version: brand && brand.version ? brand.version : SERVER_VERSION,
    ProductName: brand && brand.productName ? brand.productName : 'Jellyfin Server',
    OperatingSystem: 'Triboon',
    Id: doorServerId(),
    StartupWizardCompleted: true,
  };
}

function jellyfinUserId(user) {
  const hex = crypto.createHash('sha256').update(`triboon-jf-user:${user.id}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function userFromJellyfinId(id) {
  const want = String(id || '').toLowerCase();
  let list = [];
  try { list = deps.auth._users().list || []; } catch { list = []; }
  return list.find((u) => u.id === want || jellyfinUserId(u) === want) || null;
}

function userDto(user) {
  return {
    Name: user.name,
    ServerId: doorServerId(),
    Id: jellyfinUserId(user),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    // The TV app refuses to sign in if any of these fields are missing.
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleMode: 'Default',
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: false,
    },
    Policy: {
      IsAdministrator: user.role === 'admin',
      IsHidden: false,
      IsDisabled: false,
      EnableUserPreferenceAccess: true,
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      ForceRemoteSourceTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDownloading: false,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnableAllDevices: true,
      EnableAllChannels: false,
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: 10,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: '',
      PasswordResetProviderId: '',
      SyncPlayAccess: 'None',
    },
  };
}

function owns(ctx, id) {
  if (!id) return true;
  if (ctx.user && (ctx.user.role === 'admin' || String(ctx.user.id) === String(id) || jellyfinUserId(ctx.user) === String(id).toLowerCase())) return true;
  return false;
}

// The TV app only accepts item ids shaped like 8-4-4-4-12. Ours are short
// (m550, viewmovies, l{library}i{file}). Pack the short id into that shape
// and unpack it when the app asks for the same poster again.
const ITEM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidFromBytes(buf) {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function u32(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return null;
  return v;
}

function u16(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
  return v;
}

function publicItemId(short) {
  const id = String(short || '');
  if (ITEM_UUID.test(id)) return internalItemId(id) === id.toLowerCase() ? id.toLowerCase() : publicItemId(internalItemId(id));
  const buf = Buffer.alloc(16);
  let m;
  const tmdb = (kind, value) => {
    const n = u32(value);
    if (n == null) return false;
    buf[0] = kind;
    buf.writeUInt32BE(n, 1);
    return true;
  };
  if (id === 'viewmovies') buf[0] = 1;
  else if (id === 'viewshows') buf[0] = 2;
  else if ((m = /^m(\d+)$/.exec(id)) && tmdb(3, m[1])) { /* movie */ }
  else if ((m = /^t(\d+)$/.exec(id)) && tmdb(4, m[1])) { /* series */ }
  else if ((m = /^n(\d+)s(\d+)$/.exec(id)) && tmdb(5, m[1]) && u16(m[2]) != null) buf.writeUInt16BE(u16(m[2]), 5);
  else if ((m = /^e(\d+)s(\d+)e(\d+)$/.exec(id)) && tmdb(6, m[1]) && u16(m[2]) != null && u16(m[3]) != null) {
    buf.writeUInt16BE(u16(m[2]), 5);
    buf.writeUInt16BE(u16(m[3]), 7);
  } else if ((m = /^p(\d+)$/.exec(id)) && tmdb(7, m[1])) { /* person */ }
  else if ((m = /^l([0-9a-f]{10})i(\d+)s(\d+)$/i.exec(id)) && u32(m[2]) != null && u16(m[3]) != null) {
    buf[0] = 10;
    Buffer.from(m[1], 'hex').copy(buf, 1);
    buf.writeUInt32BE(u32(m[2]), 6);
    buf.writeUInt16BE(u16(m[3]), 10);
  } else if ((m = /^l([0-9a-f]{10})i(\d+)$/i.exec(id)) && u32(m[2]) != null) {
    buf[0] = 9;
    Buffer.from(m[1], 'hex').copy(buf, 1);
    buf.writeUInt32BE(u32(m[2]), 6);
  } else if ((m = /^l([0-9a-f]{10})$/i.exec(id))) {
    buf[0] = 8;
    Buffer.from(m[1], 'hex').copy(buf, 1);
  } else {
    const hash = crypto.createHash('sha256').update(`triboon-jf-item:${id}`).digest().subarray(0, 16);
    hash[0] = 15;
    return uuidFromBytes(hash);
  }
  return uuidFromBytes(buf);
}

function internalItemId(incoming) {
  const id = String(incoming || '');
  if (!ITEM_UUID.test(id)) return id;
  const buf = Buffer.from(id.replace(/-/g, ''), 'hex');
  const kind = buf[0];
  const n = buf.readUInt32BE(1);
  const lib = buf.subarray(1, 6).toString('hex');
  if (kind === 1) return 'viewmovies';
  if (kind === 2) return 'viewshows';
  if (kind === 3) return `m${n}`;
  if (kind === 4) return `t${n}`;
  if (kind === 5) return `n${n}s${buf.readUInt16BE(5)}`;
  if (kind === 6) return `e${n}s${buf.readUInt16BE(5)}e${buf.readUInt16BE(7)}`;
  if (kind === 7) return `p${n}`;
  if (kind === 8) return `l${lib}`;
  if (kind === 9) return `l${lib}i${buf.readUInt32BE(6)}`;
  if (kind === 10) return `l${lib}i${buf.readUInt32BE(6)}s${buf.readUInt16BE(10)}`;
  return id.toLowerCase();
}

function stampItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.Id) {
    const short = internalItemId(item.Id);
    item.Id = publicItemId(short);
    if (item.UserData && typeof item.UserData === 'object') {
      item.UserData.PlaybackPositionTicks = Number(item.UserData.PlaybackPositionTicks) || 0;
      item.UserData.PlayCount = Number(item.UserData.PlayCount) || 0;
      item.UserData.IsFavorite = !!item.UserData.IsFavorite;
      item.UserData.Played = !!item.UserData.Played;
      item.UserData.Key = short;
      item.UserData.ItemId = item.Id;
    }
  }
  for (const key of ['ParentId', 'SeriesId', 'SeasonId']) {
    if (typeof item[key] === 'string' && item[key]) item[key] = publicItemId(item[key]);
  }
  if (Array.isArray(item.People)) item.People.forEach(stampItem);
  // Android TV 0.19 carries the last audio language into the next play and
  // reads it from the item's first source before PlaybackInfo. No source
  // there is a NullPointerException: play one title, back out, play another,
  // and the app dies. PlaybackInfo swaps in the real source.
  if ((item.Type === 'Movie' || item.Type === 'Episode') && item.Id
    && !(Array.isArray(item.MediaSources) && item.MediaSources.length)) {
    item.MediaSources = [placeholderSource(item.Id, item.RunTimeTicks)];
  }
  return item;
}

function placeholderSource(id, runTimeTicks) {
  return completeSource({
    Id: id,
    IsRemote: false,
    RunTimeTicks: runTimeTicks || null,
    MediaStreams: [
      completeStream({ Index: 0, Type: 'Video', IsDefault: true, DisplayTitle: 'Video' }),
      completeStream({ Index: 1, Type: 'Audio', IsDefault: true, DisplayTitle: 'Audio' }),
    ],
  });
}

// Item ids are short and stable. A movie is m550, a show is t1396, a season is
// n1396s2, an episode is e1396s2e5. Browsing these never mounts usenet.
function parseItemId(id) {
  const s = internalItemId(id).toLowerCase();
  let m = s.match(/^m(\d{1,10})$/);
  if (m) return { type: 'movie', tmdbId: Number(m[1]) };
  m = s.match(/^t(\d{1,10})$/);
  if (m) return { type: 'series', tmdbId: Number(m[1]) };
  m = s.match(/^n(\d{1,10})s(\d{1,3})$/);
  if (m) return { type: 'season', tmdbId: Number(m[1]), season: Number(m[2]) };
  m = s.match(/^e(\d{1,10})s(\d{1,3})e(\d{1,4})$/);
  if (m) return { type: 'episode', tmdbId: Number(m[1]), season: Number(m[2]), episode: Number(m[3]) };
  m = s.match(/^p(\d{1,10})$/);
  if (m) return { type: 'person', tmdbId: Number(m[1]) };
  m = s.match(/^l([a-f0-9]{8,40})i(\d{1,8})s(\d{1,4})$/);
  if (m) return { type: 'localseason', libId: m[1], idx: Number(m[2]), season: Number(m[3]) };
  m = s.match(/^l([a-f0-9]{8,40})i(\d{1,8})$/);
  if (m) return { type: 'local', libId: m[1], idx: Number(m[2]) };
  m = s.match(/^l([a-f0-9]{8,40})$/);
  if (m) return { type: 'locallib', libId: m[1] };
  return null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// The loading card is always a 2 second piece. A shorter label still sends
// that whole 2 second file, and the phone then jumps onto the wrong cut.
const RESUME_PAD_SECONDS = 2;

// How far into the real picture the saved minute should sit. The phone
// restarts the same second when the jump lands on a cut, including the last
// few milliseconds of a piece. Sit in the middle of a piece the phone
// already has. Pad pieces stay whole 2 second steps, so this distance is
// the saved minute minus a multiple of 2.
function resumeOffsetSeconds(start, durations) {
  const durs = (durations || []).filter((n) => n > 0.05);
  if (!(start >= 1) || !durs.length) return 0;
  let covered = 0;
  for (const dur of durs) {
    covered += dur;
    if (covered >= 12) break;
  }
  let best = 0;
  let bestGap = 0;
  const first = start % RESUME_PAD_SECONDS;
  const last = Math.min(start - 0.5, Math.max(covered, RESUME_PAD_SECONDS));
  for (let offset = first; offset <= last + 0.001; offset += RESUME_PAD_SECONDS) {
    if (offset < 0.5) continue;
    let at = 0;
    for (const dur of durs) {
      const end = at + dur;
      const gap = Math.min(offset - at, end - offset);
      if (offset + 0.001 >= at + 0.35 && offset <= end - 0.35 && gap > bestGap) {
        bestGap = gap;
        best = offset;
        break;
      }
      at = end;
      if (at > offset + 0.001) break;
    }
  }
  if (best >= 0.5) return Math.round(best * 1000) / 1000;
  // Even pieces put every 2 second step on a cut. Use the next piece's
  // start. That is still after the loading card, and it is a clean picture.
  const stepped = first >= 0.5 ? first : first + RESUME_PAD_SECONDS;
  if (stepped >= 0.5 && stepped < start) return Math.round(stepped * 1000) / 1000;
  return 0;
}

// The phone seeks to the saved minute. ffmpeg already starts the picture there, but the
// playlist clock would still say 0, so the phone waits until that many seconds exist.
// Quiet pieces fill the clock in whole 2 second steps. The jump then sits in
// the middle of a real piece, not on a cut.
function resumeClockPlaylist(raw, startSeconds) {
  const start = Number(startSeconds) || 0;
  if (!(start >= 1)) return String(raw || '');
  const text = String(raw || '');
  const lines = text.split(/\n/);
  const durs = [];
  let inf = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXTINF:/.test(lines[i])) continue;
    if (inf < 0) inf = text.search(/^#EXTINF:/m);
    if (/^seg\d+\.m4s/.test(String(lines[i + 1] || ''))) {
      const row = lines[i].match(/^#EXTINF:([0-9.]+),/);
      durs.push(row ? Number(row[1]) || 0 : 0);
    }
  }
  const padFor = Math.max(0, Math.round((start - resumeOffsetSeconds(start, durs)) * 1000) / 1000);
  const pushPads = (into) => {
    let left = padFor;
    while (left > 0.01) {
      const dur = Math.min(RESUME_PAD_SECONDS, left);
      into.push(`#EXTINF:${dur.toFixed(3)},`, 'pad.m4s');
      left = Math.round((left - dur) * 1000) / 1000;
    }
  };
  // No picture pieces yet. Still answer at once so the phone does not time out
  // while the movie is opening at the saved minute. The next list adds the picture.
  // A loading card is not the picture, so it does not count as a real piece.
  if (inf < 0 || durs.length === 0) {
    const base = inf < 0 && text.includes('#EXTM3U')
      ? text.replace(/\s*$/, '\n')
      : '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n';
    const pads = ['#EXT-X-MAP:URI="padinit.mp4"'];
    pushPads(pads);
    return `${base}${pads.join('\n')}\n`;
  }
  if (!(padFor > 0.01)) return text;
  const head = text.slice(0, inf);
  const map = (head.match(/#EXT-X-MAP:[^\n]*\n/) || [''])[0];
  const pads = ['#EXT-X-MAP:URI="padinit.mp4"'];
  pushPads(pads);
  pads.push('#EXT-X-DISCONTINUITY');
  return `${head.replace(/#EXT-X-MAP:[^\n]*\n/, '')}${pads.join('\n')}\n${map}${text.slice(inf)}`;
}

// The Loading card and the resume pads move the phone's clock away from the
// movie's clock. Captions are timed to the movie, so they need the same move.
// Card: 6s of card, movie 0:00 plays at clock 6s, captions go 6s later.
// Resume: pads stop short of the saved minute, captions go that much earlier.
function playlistClockShift(raw, movieStartSeconds = 0) {
  let clock = 0;
  const lines = String(raw || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].match(/^#EXTINF:([0-9.]+),/);
    if (!row) continue;
    if (/^seg\d+\.m4s/.test(String(lines[i + 1] || ''))) {
      return Math.round((clock - (Number(movieStartSeconds) || 0)) * 1000) / 1000;
    }
    clock += Number(row[1]) || 0;
  }
  return null;
}

// The phone draws the bar from the playlist. A list that only contains the
// pieces made so far looks like a short movie, and a drag stops at the end
// of that short piece. Name every remaining piece through the real runtime
// and close the list, so the bar is the whole movie. Pieces that are not
// encoded yet are filled when the phone asks for them.
function fullTimelinePlaylist(raw, durationSeconds, segmentSeconds = 2) {
  const duration = Number(durationSeconds) || 0;
  const step = Number(segmentSeconds) > 0 ? Number(segmentSeconds) : 2;
  const text = String(raw || '');
  if (!(duration >= 1) || duration > 10 * 3600 || !/#EXTINF:/.test(text)) return text;
  const body = text.replace(/^#EXT-X-ENDLIST\s*$/m, '').replace(/\s*$/, '\n');
  const durs = [...body.matchAll(/^#EXTINF:([0-9.]+),/gm)].map((row) => Number(row[1]) || 0);
  let sum = durs.reduce((total, n) => total + n, 0);
  let maxIdx = -1;
  for (const row of body.matchAll(/^seg(\d+)\.m4s$/gm)) {
    const n = parseInt(row[1], 10);
    if (n > maxIdx) maxIdx = n;
  }
  const lines = [];
  let idx = maxIdx + 1;
  while (sum < duration - 0.05 && idx < 20000) {
    const dur = Math.min(step, Math.round((duration - sum) * 1000) / 1000);
    if (!(dur > 0.01)) break;
    lines.push(`#EXTINF:${dur.toFixed(3)},`, `seg${String(idx).padStart(5, '0')}.m4s`);
    sum += dur;
    idx += 1;
  }
  let out = body;
  if (lines.length) out += `${lines.join('\n')}\n`;
  if (!/#EXT-X-ENDLIST/.test(out)) out += '#EXT-X-ENDLIST\n';
  return out;
}

const resumeOrigin = new Map();

function rememberResumeOrigin(uid, itemId, seconds) {
  const key = watchKeyFromId(itemId);
  if (!uid || !key) return;
  resumeOrigin.set(`${uid}:${key}`, Math.max(0, Number(seconds) || 0));
}

function progressSeconds(uid, itemId, reported) {
  const key = watchKeyFromId(itemId);
  const origin = key && uid ? (resumeOrigin.get(`${uid}:${key}`) || 0) : 0;
  const pos = Math.max(0, Math.round(Number(reported) || 0));
  if (origin >= 1 && pos + 15 < origin) return pos + origin;
  return pos;
}

function posterUrl(file, kind) {
  const p = String(file || '');
  if (!p.startsWith('/')) return '';
  const size = kind === 'backdrop' ? 'w1280' : 'w500';
  const loc = `https://image.tmdb.org/t/p/${size}${p}`;
  // Only the picture host. A folder name must not become a fetch to somewhere else.
  if (!/^https:\/\/image\.tmdb\.org\/t\/p\/w\d+\/[A-Za-z0-9._~/-]+$/.test(loc)) return '';
  return loc;
}

const posterCache = new Map();
const POSTER_BYTES_MAX = 2 * 1024 * 1024;

function imageType(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function fetchPosterBytes(loc, hops = 0) {
  return new Promise((resolve) => {
    if (!loc || hops > 2) return resolve(null);
    const req = https.get(loc, { headers: { 'user-agent': 'Triboon', accept: 'image/*' }, timeout: 8000 }, (res) => {
      const next = res.statusCode >= 300 && res.statusCode < 400 ? String(res.headers.location || '') : '';
      if (next) {
        res.resume();
        if (!next.startsWith('https://image.tmdb.org/')) return resolve(null);
        return resolve(fetchPosterBytes(next, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > POSTER_BYTES_MAX) { tooBig = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (tooBig) return resolve(null);
        const body = Buffer.concat(chunks);
        const type = imageType(body);
        resolve(type ? { type, body } : null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// The TV asked this server for the picture. Hand back the bytes. A jump to
// image.tmdb.org is a different site, and the house Wi-Fi app leaves it blank.
async function sendPoster(ctx, cors, file, wide) {
  const { send } = deps;
  const loc = posterUrl(file, wide ? 'backdrop' : 'poster');
  if (!loc) return send(ctx.res, 404, { error: 'not found' }, cors);
  if (process.env.TRIBOON_POSTER_STUB === '1') {
    const body = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    ctx.res.writeHead(200, {
      ...cors,
      'content-type': 'image/jpeg',
      'content-length': body.length,
      'cache-control': 'public, max-age=86400',
      'x-triboon-poster': String(file || ''),
    });
    return ctx.res.end(body);
  }
  let fetched = posterCache.get(loc);
  if (!fetched) {
    fetched = await fetchPosterBytes(loc);
    if (fetched) {
      if (posterCache.size > 100) posterCache.delete(posterCache.keys().next().value);
      posterCache.set(loc, fetched);
    }
  }
  if (!fetched) return send(ctx.res, 404, { error: 'not found' }, cors);
  ctx.res.writeHead(200, {
    ...cors,
    'content-type': fetched.type,
    'content-length': fetched.body.length,
    'cache-control': 'public, max-age=86400',
  });
  return ctx.res.end(fetched.body);
}

function ticks(minutes) {
  const n = Number(minutes) || 0;
  if (n <= 0) return 0;
  return Math.round(n * 60 * 10000000);
}

function shelfCoverFile(which) {
  if (typeof deps.jellyfinCoverFile === 'function') {
    const custom = deps.jellyfinCoverFile(which);
    if (custom && fs.existsSync(custom)) return custom;
  }
  const names = {
    shows: 'shows.png',
    library: 'library.png',
    'custom-movies': 'custom-movies.jpg',
    'custom-shows': 'custom-shows.jpg',
  };
  const name = names[which] || 'movies.png';
  const file = path.join(__dirname, '..', 'web', 'jellyfin-covers', name);
  return fs.existsSync(file) ? file : '';
}

function coverArtTag(poster, cover) {
  const which = cover || (poster === 'xshow' ? 'custom-shows' : poster === 'xmovie' ? 'custom-movies' : 'library');
  const file = typeof deps.jellyfinCoverFile === 'function' ? deps.jellyfinCoverFile(which) : '';
  let stamp = '';
  if (file) {
    try { stamp = String(Math.floor(fs.statSync(file).mtimeMs)); } catch { stamp = ''; }
  }
  if (poster === 'shelf' || poster === 'home') return stamp ? `home${stamp}` : 'home1';
  if (poster === 'xmovie' || poster === 'xshow') return stamp ? `${poster}${stamp}` : poster;
  return 'p';
}

// A person's own folder is not the built-in Movies or Shows card.
// Movie folders get the popcorn picture. Show folders get the cinema sign.
// Music, sports, and other folders keep the Library shelf.
function shelfCoverForKind(kind) {
  if (kind === 'tv') return 'custom-shows';
  if (kind === 'movie') return 'custom-movies';
  return 'library';
}

// The home cards are JPEG photos saved with a .png name. Roku and Android TV
// trust the label and die while drawing the first row. The emulator sniffs
// the bytes and keeps going. The label has to match the bytes.
function imageMime(file) {
  let buf = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(12);
      fs.readSync(fd, buf, 0, 12, 0);
    } finally { fs.closeSync(fd); }
  } catch { buf = null; }
  if (buf && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.webp$/i.test(file)) return 'image/webp';
  return 'image/jpeg';
}

function localPicture(ctx, libId, idx, wide) {
  if (typeof deps.localImage !== 'function') return null;
  return deps.localImage(ctx, libId, idx, wide) || (wide ? deps.localImage(ctx, libId, idx, false) : null);
}

function episodePicture(ctx, libId, idx, wide) {
  const own = localPicture(ctx, libId, idx, wide);
  if (own) return own;
  if (typeof deps.localOne !== 'function') return null;
  const row = deps.localOne(ctx, libId, idx);
  const showIdx = row && row.kind === 'episode' ? Number(row.showIdx) : NaN;
  if (!Number.isInteger(showIdx) || showIdx === Number(idx)) return null;
  return localPicture(ctx, libId, showIdx, wide);
}

function baseItem(fields) {
  const imageTags = {};
  const homeArt = fields.poster === 'shelf' || fields.poster === 'home';
  const extraArt = fields.poster === 'xmovie' || fields.poster === 'xshow';
  const episodeArt = fields.type === 'Episode';
  const shelfTag = (homeArt || extraArt) ? coverArtTag(fields.poster, fields.cover) : '';
  if (fields.poster) imageTags.Primary = shelfTag || (episodeArt ? 'still1' : fields.poster === 'local' ? 'disk2' : 'p');
  if (fields.thumb) imageTags.Thumb = shelfTag || (episodeArt ? 'still1' : 't');
  return stampItem({
    ServerId: doorServerId(),
    ImageTags: imageTags,
    BackdropImageTags: fields.backdrop ? [episodeArt ? 'still1' : 'b'] : [],
    PrimaryImageAspectRatio: fields.aspect || (fields.poster ? 0.6666667 : null),
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false },
    ChildCount: fields.childCount || 0,
    ...fields.extra,
    Name: fields.name || '',
    Id: fields.id,
    Type: fields.type,
    Overview: fields.overview || '',
    ProductionYear: fields.year || null,
    PremiereDate: fields.premiere ? `${String(fields.premiere).slice(0, 10)}T00:00:00.0000000Z` : null,
    RunTimeTicks: ticks(fields.runtime),
  });
}

function named(list) {
  return (Array.isArray(list) ? list : []).map((row) => row && row.name).filter(Boolean);
}

function certification(row, kind) {
  if (kind === 'movie') {
    const results = row.release_dates && row.release_dates.results;
    const us = Array.isArray(results) && results.find((entry) => entry.iso_3166_1 === 'US');
    const hit = us && Array.isArray(us.release_dates) && us.release_dates.find((entry) => entry.certification);
    return (hit && hit.certification) || '';
  }
  const results = row.content_ratings && row.content_ratings.results;
  const us = Array.isArray(results) && results.find((entry) => entry.iso_3166_1 === 'US');
  return (us && us.rating) || '';
}

function personDto(row, type, role) {
  if (!row || !row.id || !row.name) return null;
  const person = { Name: row.name, Id: `p${row.id}`, Type: type, Role: role || type };
  if (row.profile_path) person.PrimaryImageTag = 'p';
  return stampItem(person);
}

function peopleOf(credits) {
  if (!credits) return [];
  const out = [];
  for (const row of credits.crew || []) {
    if (!row || (row.job !== 'Director' && row.job !== 'Writer')) continue;
    const person = personDto(row, row.job, row.job);
    if (person) out.push(person);
  }
  for (const row of (credits.cast || []).slice(0, 15)) {
    const person = personDto(row, 'Actor', row.character || 'Actor');
    if (person) out.push(person);
  }
  return out;
}

// List rows stay light. A details page has genres, a star rating, the US
// rating, the studio, and the cast, which is what the Jellyfin page paints.
function nameGuid(name) {
  const hex = crypto.createHash('sha1').update(`triboon-name:${String(name)}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function detailExtra(row, kind) {
  const extra = {};
  const genres = named(row.genres);
  if (genres.length) {
    extra.Genres = genres;
    extra.GenreItems = genres.map((name) => ({ Name: name, Id: nameGuid(name) }));
  }
  if (Number(row.vote_average) > 0) extra.CommunityRating = Math.round(Number(row.vote_average) * 10) / 10;
  const cert = certification(row, kind);
  if (cert) extra.OfficialRating = cert;
  const studios = named(row.production_companies);
  if (studios.length) extra.Studios = studios.map((name) => ({ Name: name, Id: nameGuid(`studio:${name}`) }));
  if (row.tagline) extra.Taglines = [row.tagline];
  if (row.status) extra.Status = row.status;
  const people = peopleOf(row.credits);
  if (people.length) extra.People = people;
  if (row.original_title || row.original_name) extra.OriginalTitle = row.original_title || row.original_name;
  return extra;
}

function movieItem(row) {
  const year = Number(String(row.release_date || '').slice(0, 4)) || null;
  return baseItem({
    id: `m${row.id}`, name: row.title || row.name || '', type: 'Movie',
    overview: row.overview || '', year, premiere: row.release_date || null,
    runtime: row.runtime, poster: row.poster_path, backdrop: row.backdrop_path, aspect: 0.6666667, childCount: 0,
    extra: { MediaType: 'Video', LocationType: 'Remote', ...detailExtra(row, 'movie') },
  });
}

function seriesItem(row) {
  const year = Number(String(row.first_air_date || '').slice(0, 4)) || null;
  return baseItem({
    id: `t${row.id}`, name: row.name || row.title || '', type: 'Series',
    overview: row.overview || '', year, premiere: row.first_air_date || null,
    poster: row.poster_path, backdrop: row.backdrop_path, aspect: 0.6666667,
    childCount: Number(row.number_of_seasons) || 0,
    extra: { IsFolder: true, ...detailExtra(row, 'tv') },
  });
}

async function tmdbGet(path) {
  if (!deps.tmdb || typeof deps.tmdb.get !== 'function') return null;
  try { return await deps.tmdb.get(path); } catch { return null; }
}

function queryInt(q, names, fallback) {
  for (const name of names) {
    const n = parseInt(q && q.get(name), 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function windowOf(ctx) {
  const q = ctx.url && ctx.url.searchParams;
  const start = Math.max(0, queryInt(q, ['StartIndex', 'startIndex'], 0));
  const limit = Math.min(100, Math.max(1, queryInt(q, ['Limit', 'limit'], 40)));
  return { start, limit };
}

const GENRE_BY_ID = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
  10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};
const GENRE_BY_NAME = new Map(Object.entries(GENRE_BY_ID).map(([id, name]) => [name.toLowerCase(), Number(id)]));

function listParam(q, names) {
  const raw = names.map((name) => q && q.get(name)).find((value) => value != null && value !== '');
  if (!raw) return [];
  return String(raw).split(/[|,]/).map((part) => part.trim()).filter(Boolean);
}

function queryView(ctx) {
  const q = ctx.url && ctx.url.searchParams;
  const sortBy = String((q && (q.get('SortBy') || q.get('sortBy'))) || '');
  const sortOrder = String((q && (q.get('SortOrder') || q.get('sortOrder'))) || 'Ascending');
  return {
    sortBy,
    asc: /asc/i.test(sortOrder),
    filters: listParam(q, ['Filters', 'filters']).map((part) => part.toLowerCase()),
    genres: listParam(q, ['Genres', 'genres']),
    genreIds: listParam(q, ['GenreIds', 'genreIds']).map((part) => parseInt(part, 10)).filter((n) => n > 0),
    years: listParam(q, ['Years', 'years']).map((part) => parseInt(part, 10)).filter(Boolean),
    starts: String((q && (q.get('NameStartsWith') || q.get('nameStartsWith'))) || ''),
    before: String((q && (q.get('NameLessThan') || q.get('nameLessThan'))) || ''),
    search: String((q && (q.get('SearchTerm') || q.get('searchTerm'))) || ''),
  };
}

const TV_GENRE_ALIAS = {
  action: 10759, adventure: 10759, 'action & adventure': 10759,
  'science fiction': 10765, fantasy: 10765, 'sci-fi & fantasy': 10765,
  kids: 10762, news: 10763, reality: 10764, soap: 10766, talk: 10767,
  war: 10768, 'war & politics': 10768,
};
const MOVIE_GENRE_ALIAS = {
  'action & adventure': 28,
  'sci-fi & fantasy': 878,
  kids: 10751,
  'war & politics': 10752,
};

function genreIdsFromNames(names, kind) {
  return (names || []).map((name) => {
    const key = String(name).toLowerCase();
    if (kind === 'series' || kind === 'tv') return TV_GENRE_ALIAS[key] || GENRE_BY_NAME.get(key);
    if (kind === 'movie') return MOVIE_GENRE_ALIAS[key] || GENRE_BY_NAME.get(key);
    return GENRE_BY_NAME.get(key);
  }).filter(Boolean);
}

function sortKey(view) {
  return String(view && view.sortBy || '').toLowerCase().split(',')[0].trim();
}

function localSort(view) {
  const by = sortKey(view);
  const asc = !!(view && view.asc);
  if (!by) return 'title.asc';
  if (by.includes('datelastcontentadded')) return asc ? 'content.asc' : 'content.desc';
  if (by.includes('random')) return 'random';
  if (by.includes('runtime')) return asc ? 'runtime.asc' : 'runtime.desc';
  if (by.includes('community') || by.includes('critic')) return asc ? 'rating.asc' : 'rating.desc';
  if (by.includes('premier') || by.includes('productionyear')) return asc ? 'year.asc' : 'year.desc';
  if (by.includes('datecreated') || by.includes('dateplayed')) return asc ? 'added.asc' : 'added.desc';
  return asc ? 'title.asc' : 'title.desc';
}

function tmdbSort(kind, view) {
  const by = sortKey(view);
  if (!by) return 'popularity.desc';
  const dir = view.asc ? 'asc' : 'desc';
  if (by.includes('community') || by.includes('critic')) return `vote_average.${dir}`;
  if (by === 'sortname' || by === 'name' || by === 'seriessortname') {
    return kind === 'movie' ? `original_title.${dir}` : `original_name.${dir}`;
  }
  if (by.includes('premier') || by.includes('productionyear') || by.includes('datecreated') || by.includes('datelastcontentadded')) {
    return kind === 'movie' ? `primary_release_date.${dir}` : `first_air_date.${dir}`;
  }
  return 'popularity.desc';
}

function nameStartsWith(name, letter) {
  const want = String(letter || '').trim().toLowerCase();
  if (!want) return true;
  const raw = String(name || '').trim().toLowerCase();
  const stripped = raw.replace(/^(the|an|a)\s+/, '');
  return stripped.startsWith(want) || raw.startsWith(want);
}

function savedMatches(row, filters) {
  const played = !!(row && row.watched);
  const favorite = !!(row && row.favorite);
  const resumable = !!(row && !row.watched && Number(row.position) > 30);
  for (const filter of filters || []) {
    if (filter === 'isplayed' && !played) return false;
    if (filter === 'isunplayed' && played) return false;
    if (filter === 'isresumable' && !resumable) return false;
    if (filter === 'isfavorite' && !favorite) return false;
  }
  return true;
}

function watchFilters(filters) {
  return (filters || []).some((filter) => filter === 'isplayed' || filter === 'isunplayed' || filter === 'isresumable' || filter === 'isfavorite');
}

// The current Jellyfin TV app refuses to open a movie if any of these are missing.
function completeSource(row) {
  return {
    Protocol: 'File',
    Type: 'Default',
    Container: 'mp4',
    IsRemote: true,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: true,
    SupportsDirectStream: false,
    SupportsDirectPlay: false,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    TranscodingSubProtocol: 'http',
    HasSegments: false,
    ...row,
  };
}

function completeStream(row) {
  return {
    IsInterlaced: false,
    IsDefault: false,
    IsForced: false,
    IsExternal: false,
    IsHearingImpaired: false,
    IsTextSubtitleStream: false,
    SupportsExternalStream: false,
    ...row,
    IsDefault: row.IsDefault === true,
    IsTextSubtitleStream: row.Type === 'Subtitle',
    SupportsExternalStream: row.Type === 'Subtitle' && row.IsExternal !== false,
  };
}

function videoRangeType(track) {
  if (!track) return 'SDR';
  if (track.rangeType) return track.rangeType;
  return track.hdr ? 'HDR10' : 'SDR';
}

function videoRange(track) {
  return videoRangeType(track) === 'SDR' ? 'SDR' : 'HDR';
}

// ---------- direct play ----------
// Each Jellyfin app sends the formats its own player handles. When the file
// fits, the app plays the original bytes with seeking and its own buffer, and
// no ffmpeg runs here. Anything unsure stays on the encoded HLS copy.
const CONTAINER_NAMES = {
  mkv: ['mkv', 'matroska', 'webm'],
  mp4: ['mp4', 'm4v', 'mov'],
  ts: ['ts', 'mpegts', 'm2ts'],
  avi: ['avi'],
};
const CODEC_NAMES = {
  hevc: ['hevc', 'h265'],
  h264: ['h264', 'avc'],
  dts: ['dts', 'dca'],
  mpeg2video: ['mpeg2video', 'mpeg2'],
};

function sourceContainer(probe, fileName) {
  const fmt = String((probe && probe.format) || '').toLowerCase();
  if (fmt.includes('matroska') || fmt.includes('webm')) return 'mkv';
  if (fmt.includes('mp4') || fmt.includes('mov')) return 'mp4';
  if (fmt.includes('mpegts')) return 'ts';
  if (fmt.includes('avi')) return 'avi';
  const ext = /\.([a-z0-9]{2,4})$/i.exec(String(fileName || ''));
  const e = ext ? ext[1].toLowerCase() : '';
  for (const [name, aliases] of Object.entries(CONTAINER_NAMES)) if (aliases.includes(e)) return name;
  return '';
}

function listMatches(list, value, aliases) {
  const items = String(list || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return true;
  if (!value) return false;
  const v = String(value).toLowerCase();
  const names = (aliases && aliases[v]) || [v];
  return names.some((n) => items.includes(n));
}

function queryField(ctx, body, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(body && typeof body === 'object' ? body : {})) {
    if (key.toLowerCase() === lower) return value;
  }
  const q = ctx && ctx.url && ctx.url.searchParams;
  if (q) for (const [key, value] of q) if (key.toLowerCase() === lower) return value;
  return undefined;
}

// Values the app may test. Anything left out here (RefFrames, framerate...)
// is not known before play, so it never blocks the original file.
function profileFacts(video, audio, container) {
  return {
    Width: video && video.width,
    Height: video && video.height,
    VideoBitDepth: video && video.bitDepth,
    VideoProfile: video && video.profile ? String(video.profile).toLowerCase() : null,
    VideoLevel: video && video.level,
    VideoRangeType: video ? videoRangeType(video) : null,
    AudioChannels: audio && audio.channels,
    AudioProfile: audio && audio.profile ? String(audio.profile).toLowerCase() : null,
    Container: container,
  };
}

const KNOWN_FACTS = new Set(['Width', 'Height', 'VideoBitDepth', 'VideoProfile', 'VideoLevel',
  'VideoRangeType', 'AudioChannels', 'AudioProfile']);

function conditionHolds(cond, facts) {
  const prop = String((cond && cond.Property) || '');
  if (!KNOWN_FACTS.has(prop)) return true;
  const have = facts[prop];
  if (have == null || have === '') return cond.IsRequired !== true;
  const want = String(cond.Value == null ? '' : cond.Value);
  const num = Number(have);
  const wantNum = Number(want);
  const same = (a) => (Number.isFinite(num) && a !== '' && Number.isFinite(Number(a)))
    ? Number(a) === num
    : String(a).toLowerCase() === String(have).toLowerCase();
  switch (String(cond.Condition || '')) {
    case 'Equals': return same(want);
    case 'NotEquals': return !same(want);
    case 'EqualsAny': return want.split('|').some((a) => same(a.trim()));
    case 'LessThanEqual': return Number.isFinite(wantNum) && Number.isFinite(num) ? num <= wantNum : true;
    case 'GreaterThanEqual': return Number.isFinite(wantNum) && Number.isFinite(num) ? num >= wantNum : true;
    default: return true;
  }
}

function codecProfilesAllow(profiles, kind, codec, container, facts) {
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (!p || String(p.Type || '') !== kind) continue;
    if (p.Codec && !listMatches(p.Codec, codec, CODEC_NAMES)) continue;
    if (p.Container && !listMatches(p.Container, container, CONTAINER_NAMES)) continue;
    const applies = (Array.isArray(p.ApplyConditions) ? p.ApplyConditions : []).every((c) => conditionHolds(c, facts));
    if (!applies) continue;
    if (!(Array.isArray(p.Conditions) ? p.Conditions : []).every((c) => conditionHolds(c, facts))) return false;
  }
  return true;
}

// Android TV asks for the original file with no token and no session id;
// real Jellyfin leaves that address open. Here it opens only for the device
// address this server just told to play that movie's original file. Every
// seek opens the address again, so each use keeps it open a while longer.
const directGrants = new Map();
const DIRECT_GRANT_MS = 6 * 3600 * 1000;

function grantKey(ip, itemId) {
  return `${String(ip || '')}|${internalItemId(String(itemId || '')).toLowerCase()}`;
}

function issueDirectGrant(ip, uid, itemId) {
  if (!ip || !uid) return;
  const now = Date.now();
  for (const [key, g] of directGrants) if (g.until <= now) directGrants.delete(key);
  while (directGrants.size >= 1000) directGrants.delete(directGrants.keys().next().value);
  const key = grantKey(ip, itemId);
  directGrants.delete(key);
  directGrants.set(key, { uid, until: now + DIRECT_GRANT_MS });
}

function directGrantUser(ip, url, itemId) {
  if (!ip) return null;
  if (!/^true$/i.test(String(queryField({ url }, null, 'static') || ''))) return null;
  const g = directGrants.get(grantKey(ip, itemId));
  if (!g || g.until <= Date.now()) return null;
  g.until = Date.now() + DIRECT_GRANT_MS;
  return g.uid;
}

function jellyfinAppLabel(ctx) {
  const hdr = (ctx && ctx.req && ctx.req.headers) || {};
  const blob = `${hdr.authorization || ''} ${hdr['x-emby-authorization'] || ''}`;
  const client = (blob.match(/Client="([^"]{1,40})"/i) || [])[1] || '';
  const version = (blob.match(/Version="([^"]{1,24})"/i) || [])[1] || '';
  return [client, version].filter(Boolean).join(' ') || String(hdr['user-agent'] || 'unknown app').slice(0, 60);
}

// ok only when the app said it can play this exact file. `why` goes to the log.
function directPlayCheck(ctx, body, probe, file) {
  const no = (why) => ({ ok: false, why });
  if (!file || !file.streamUrl) return no('no ranged file');
  if (!probe) return no('tracks not read yet');
  const off = (v) => v === false || String(v).toLowerCase() === 'false';
  if (off(queryField(ctx, body, 'EnableDirectPlay'))) return no('app asked for the encoded copy');
  const profile = queryField(ctx, body, 'DeviceProfile');
  if (!profile || typeof profile !== 'object') return no('app sent no player list');
  const container = sourceContainer(probe, file.name);
  if (!container) return no('unknown container');
  const video = (probe.video || [])[0];
  if (!video) return no('no video track');
  const audio = (probe.audio || [])[Math.max(0, Number(file.audioRel) || 0)] || (probe.audio || [])[0];
  const what = `${container} ${video.codec || '?'}${audio ? `/${audio.codec || '?'}` : ''}`;
  const max = Number(queryField(ctx, body, 'MaxStreamingBitrate')) || Number(profile.MaxStreamingBitrate) || 0;
  const bitRate = sourceBitRate(probe, file.size) || 0;
  if (max > 0 && bitRate > max) return no(`${what} at ${Math.round(bitRate / 1e6)} Mbps is over the app limit ${Math.round(max / 1e6)} Mbps`);
  const fits = (Array.isArray(profile.DirectPlayProfiles) ? profile.DirectPlayProfiles : []).some((p) =>
    p && String(p.Type || 'Video') === 'Video'
      && listMatches(p.Container, container, CONTAINER_NAMES)
      && listMatches(p.VideoCodec, video.codec, CODEC_NAMES)
      && (!audio || listMatches(p.AudioCodec, audio.codec, CODEC_NAMES)));
  if (!fits) return no(`${what} is not on the app list`);
  const facts = profileFacts(video, audio, container);
  if (!codecProfilesAllow(profile.CodecProfiles, 'Video', video.codec, container, facts)) return no(`${what} video limits (${facts.VideoRangeType}, ${facts.VideoBitDepth || '?'}-bit)`);
  if (audio && !codecProfilesAllow(profile.CodecProfiles, 'VideoAudio', audio.codec, container, facts)) return no(`${what} audio limits`);
  return { ok: true, why: what };
}

function sourceBitRate(probe, size) {
  if (probe && Number(probe.bitRate) > 0) return Number(probe.bitRate);
  if (probe && probe.duration > 0 && size > 0) return Math.round((size * 8) / probe.duration);
  return null;
}

function mediaStreamsFromProbe(probe) {
  if (!probe) return null;
  const streams = [];
  let index = 0;
  const video = Array.isArray(probe.video) ? probe.video : [];
  const audio = Array.isArray(probe.audio) ? probe.audio : [];
  if (!video.length && !audio.length) return null;
  for (const track of video) {
    streams.push(completeStream({
      Index: index++,
      Type: 'Video',
      Codec: track.codec || 'h264',
      Height: track.height || null,
      Width: track.width || null,
      BitDepth: track.bitDepth || null,
      Level: track.level || null,
      Profile: track.profile || null,
      VideoRange: videoRange(track),
      VideoRangeType: videoRangeType(track),
      IsDefault: streams.length === 0,
      DisplayTitle: track.height ? `${track.height}p` : 'Video',
    }));
  }
  if (!video.length) {
    streams.push(completeStream({ Index: index++, Type: 'Video', Codec: 'h264', IsDefault: true, DisplayTitle: 'Video' }));
  }
  audio.forEach((track, audioIndex) => {
    const lang = track.lang || '';
    streams.push(completeStream({
      Index: index++,
      Type: 'Audio',
      Codec: track.codec || 'aac',
      Profile: track.profile || null,
      Language: lang,
      Channels: track.channels || 2,
      IsDefault: audioIndex === 0,
      DisplayTitle: track.title || lang || `Audio ${audioIndex + 1}`,
    }));
  });
  return streams;
}

const SUB_LANG = {
  en: 'English', eng: 'English', fa: 'Persian', fas: 'Persian', per: 'Persian',
  es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', de: 'German', ger: 'German',
  ar: 'Arabic',
};

function stampSubtitleUrls(streams, itemId, mountId) {
  // The phone's page calls getUrl on every external caption. An empty address
  // throws and the play spinner dies. Point each one at the caption we serve.
  if (!Array.isArray(streams) || !itemId || !mountId) return streams;
  for (const row of streams) {
    if (!row || row.Type !== 'Subtitle' || row.DeliveryMethod !== 'External' || row.DeliveryUrl) continue;
    row.DeliveryUrl = `/videos/${itemId}/${mountId}/subtitles/${row.Index}/stream.vtt`;
  }
  return streams;
}

function subtitleStream(index, lang, title, forced) {
  const code = String(lang || '').toLowerCase();
  return completeStream({
    Index: index,
    Type: 'Subtitle',
    Codec: 'webvtt',
    Language: code,
    DisplayTitle: SUB_LANG[code] || title || 'Subtitles',
    IsDefault: false,
    IsForced: !!forced,
    IsExternal: true,
    DeliveryMethod: 'External',
  });
}

// Jellyfin's own CC button loads these. A sidecar .srt next to the movie, or a
// text track inside the file. No downloaded subtitle search.
function streamsWithSubtitles(probe, sidecars) {
  const streams = mediaStreamsFromProbe(probe) || [
    completeStream({ Index: 0, Type: 'Video', Codec: 'h264', IsDefault: true, DisplayTitle: 'Video' }),
    completeStream({ Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true, Language: '', DisplayTitle: 'Audio' }),
  ];
  const byIndex = new Map();
  let index = streams.reduce((n, row) => Math.max(n, Number(row.Index) + 1), 0);
  for (const track of (probe && probe.subs) || []) {
    if (!track || !track.text) continue;
    streams.push(subtitleStream(index, track.lang, track.title, false));
    byIndex.set(index, { embedded: track.rel });
    index += 1;
  }
  for (const file of sidecars || []) {
    streams.push(subtitleStream(index, file.lang, file.title, file.forced));
    byIndex.set(index, { file: file.file, ext: file.ext });
    index += 1;
  }
  return { streams, byIndex };
}

async function attachLocalMedia(ctx, item, parsed) {
  if (!item || !parsed || parsed.type !== 'local' || typeof deps.localMediaInfo !== 'function') return item;
  const info = await deps.localMediaInfo(ctx, parsed.libId, parsed.idx);
  if (!info) return item;
  if (info.seconds) item.RunTimeTicks = Math.round(info.seconds * 10000000);
  const streams = mediaStreamsFromProbe(info.probe);
  if (streams) {
    item.MediaSources = [completeSource({
      Id: item.Id,
      Protocol: 'File',
      RunTimeTicks: item.RunTimeTicks,
      MediaStreams: streams,
    })];
  }
  return item;
}

// Android TV reads the playing audio from DefaultAudioStreamIndex. Left out,
// it sees -1, asks for track 1, restarts the movie, and sees -1 again forever.
function chosenAudioIndex(streams, wanted) {
  const audio = (streams || []).filter((row) => row.Type === 'Audio');
  if (!audio.length) return null;
  const n = Number(wanted);
  const asked = Number.isFinite(n) ? audio.find((row) => row.Index === n) : null;
  return (asked || audio.find((row) => row.IsDefault) || audio[0]).Index;
}

function audioRelFromStreams(streams, wanted) {
  const n = Number(wanted);
  if (!Number.isFinite(n)) return 0;
  const audio = (streams || []).filter((row) => row.Type === 'Audio');
  const at = audio.findIndex((row) => row.Index === n);
  return at >= 0 ? at : 0;
}

// The catalog site hands back 20 titles per page. Keep asking for the next page
// until the shelf the app asked for is full, and tell it how many exist so it
// keeps scrolling instead of stopping at the first page.
async function catalogList(kind, start, limit, view) {
  const pageSize = 20;
  const maxPages = 500;
  const today = new Date().toISOString().slice(0, 10);
  const sort = tmdbSort(kind, view);
  const year = view && view.years && view.years[0];
  const genre = (view && view.genreIds && view.genreIds[0]) || (view && genreIdsFromNames(view.genres, kind)[0]);
  const voteFloor = !view || !view.sortBy ? (kind === 'movie' ? 300 : 100) : 50;
  const extra = [
    year ? (kind === 'movie' ? `&primary_release_year=${year}` : `&first_air_date_year=${year}`) : '',
    genre ? `&with_genres=${genre}` : '',
  ].join('');
  const base = view && view.search
    ? (kind === 'movie'
      ? `/search/movie?query=${encodeURIComponent(view.search)}&include_adult=false`
      : `/search/tv?query=${encodeURIComponent(view.search)}&include_adult=false`)
    : (kind === 'movie'
      ? `/discover/movie?sort_by=${sort}&vote_count.gte=${voteFloor}&include_adult=false&primary_release_date.lte=${today}${extra}`
      : `/discover/tv?sort_by=${sort}&vote_count.gte=${voteFloor}&include_adult=false&first_air_date.lte=${today}${extra}`);
  const first = Math.floor(start / pageSize) + 1;
  const last = Math.min(maxPages, Math.floor((start + Math.max(limit, 1) - 1) / pageSize) + 1);
  const pages = await Promise.all(
    Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => tmdbGet(`${base}&page=${first + i}`)),
  );
  const rows = [];
  let total = 0;
  let totalPages = 0;
  for (const data of pages) {
    if (!data || !Array.isArray(data.results)) continue;
    total = Number(data.total_results) || total;
    totalPages = Number(data.total_pages) || totalPages;
    rows.push(...data.results.filter((row) => row && row.id));
  }
  const cappedPages = Math.min(maxPages, totalPages || 0);
  const cappedTotal = Math.min(total || rows.length, cappedPages * pageSize);
  const localStart = start - (first - 1) * pageSize;
  const items = rows.slice(localStart, localStart + limit)
    .map((row) => (kind === 'movie' ? movieItem(row) : seriesItem(row)));
  return { items, total: cappedTotal, paged: true };
}

function pageOf(items, ctx) {
  const { start, limit } = windowOf(ctx);
  if (items && items.paged) return { Items: items.items, TotalRecordCount: items.total, StartIndex: start };
  const list = items || [];
  return { Items: list.slice(start, start + limit), TotalRecordCount: list.length, StartIndex: start };
}

// A show's episode list. Apps ask without a Limit and expect every
// episode, so a long show must not stop after the first 40.
function fullPageOf(items, ctx) {
  const q = ctx.url && ctx.url.searchParams;
  const list = items || [];
  const start = Math.max(0, queryInt(q, ['StartIndex', 'startIndex'], 0));
  const limit = queryInt(q, ['Limit', 'limit'], 0);
  const rows = limit > 0 ? list.slice(start, start + limit) : list.slice(start);
  return { Items: rows, TotalRecordCount: list.length, StartIndex: start };
}

function libraryFolder(id) {
  if (id === 'viewmovies') return baseItem({ id, name: 'Movies', type: 'CollectionFolder', poster: 'shelf', thumb: 'shelf', cover: 'movies', aspect: 0.6666667, extra: { CollectionType: 'movies', IsFolder: true } });
  if (id === 'viewshows') return baseItem({ id, name: 'Shows', type: 'CollectionFolder', poster: 'shelf', thumb: 'shelf', cover: 'shows', aspect: 0.6666667, extra: { CollectionType: 'tvshows', IsFolder: true } });
  return null;
}

async function itemById(id, ctx) {
  id = internalItemId(id);
  const folder = libraryFolder(id);
  if (folder) return folder;
  const parsed = parseItemId(id);
  if (parsed && parsed.type === 'locallib' && typeof deps.localLibraries === 'function') {
    const lib = deps.localLibraries(ctx).find((row) => row.id === parsed.libId);
    return lib ? localFolder(lib) : null;
  }
  if (parsed && parsed.type === 'localseason') {
    return baseItem({
      id: `l${parsed.libId}i${parsed.idx}s${parsed.season}`,
      name: `Season ${parsed.season}`,
      type: 'Season',
      aspect: 0.6666667,
      extra: { IsFolder: true, SeriesId: localId(parsed.libId, parsed.idx), IndexNumber: parsed.season },
    });
  }
  if (parsed && parsed.type === 'local' && typeof deps.localOne === 'function') {
    return localJellyItem(deps.localOne(ctx, parsed.libId, parsed.idx), parsed.libId);
  }
  if (!parsed) return null;
  if (parsed.type === 'movie') {
    const d = await tmdbGet(`/movie/${parsed.tmdbId}?append_to_response=credits,release_dates`);
    return d && d.id ? movieItem(d) : null;
  }
  if (parsed.type === 'series') {
    const d = await tmdbGet(`/tv/${parsed.tmdbId}?append_to_response=credits,content_ratings`);
    return d && d.id ? seriesItem(d) : null;
  }
  if (parsed.type === 'season') {
    const seasons = await seasonsFor(parsed.tmdbId);
    return seasons.find((row) => internalItemId(row.Id) === `n${parsed.tmdbId}s${parsed.season}`) || null;
  }
  if (parsed.type === 'episode') {
    const episodes = await episodesFor(parsed.tmdbId, parsed.season);
    return episodes.find((row) => internalItemId(row.Id) === `e${parsed.tmdbId}s${parsed.season}e${parsed.episode}`) || null;
  }
  return null;
}

function localId(libId, idx) { return `l${libId}i${idx}`; }

// The same keys the Triboon app stores, so a stop in Jellyfin shows up at home too.
function watchKeyFromId(id) {
  const parsed = parseItemId(id);
  if (!parsed) return '';
  if (parsed.type === 'movie') return `tmdb:movie:${parsed.tmdbId}`;
  if (parsed.type === 'series') return `tmdb:tv:${parsed.tmdbId}`;
  if (parsed.type === 'episode') return `tmdb:tv:${parsed.tmdbId}:s${parsed.season}e${parsed.episode}`;
  if (parsed.type === 'season') return `tmdb:tv:${parsed.tmdbId}:s${parsed.season}`;
  if (parsed.type === 'local') return `local:${parsed.libId}:${parsed.idx}`;
  if (parsed.type === 'localseason') return `local:${parsed.libId}:${parsed.idx}:s${parsed.season}`;
  return '';
}

function userDataFromRow(row, fallbackSeconds, itemId) {
  const position = Math.max(0, Number(row && row.position) || 0);
  const duration = Math.max(0, Number(row && row.duration) || fallbackSeconds || 0);
  const pct = Number(row && row.traktPct) || 0;
  // A Trakt import often has a percent and no minute. The bar and the Resume
  // button need a clock, or the TV starts that movie at the beginning.
  const clock = position > 30 ? position : (pct > 2 && duration > 0 ? Math.round(duration * pct / 100) : position);
  const playedPct = position > 30 && duration
    ? Math.round((position / duration) * 1000) / 10
    : (pct > 2 ? pct : (duration ? Math.round((position / duration) * 1000) / 10 : 0));
  const short = internalItemId(itemId);
  const played = !!(row && row.watched);
  let lastPlayed = null;
  if (played) {
    const at = new Date(row && row.updatedAt || Date.now());
    lastPlayed = Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
  }
  // Android TV reads these as numbers. A missing one, or a 404 body, closes the app
  // when you mark watched or favorite.
  return {
    PlaybackPositionTicks: Math.round(clock * 10000000) || 0,
    PlayedPercentage: Number.isFinite(playedPct) ? playedPct : 0,
    PlayCount: played ? 1 : 0,
    IsFavorite: !!(row && row.favorite),
    Played: played,
    UnplayedItemCount: played ? 0 : 1,
    LastPlayedDate: lastPlayed,
    Key: short || publicItemId(itemId),
    ItemId: publicItemId(short || itemId),
  };
}

function paintWatch(ctx, item) {
  if (!item || !item.Id || typeof deps.jellyfinWatchGet !== 'function') return item;
  const row = deps.jellyfinWatchGet(ctx, watchKeyFromId(item.Id));
  if (!row) return item;
  const fallback = item.RunTimeTicks ? item.RunTimeTicks / 10000000 : 0;
  item.UserData = userDataFromRow(row, fallback, item.Id);
  return item;
}

function paintPage(ctx, page) {
  if (page && Array.isArray(page.Items)) page.Items.forEach((item) => paintWatch(ctx, item));
  return page;
}

function itemFromWatchRow(ctx, row) {
  if (!row || !row.key) return null;
  const meta = row.meta || {};
  const duration = Math.max(0, Number(row.duration) || 0);
  const extra = {
    MediaType: 'Video',
    LocationType: 'Remote',
    UserData: userDataFromRow(row, duration),
  };
  const movie = /^tmdb:movie:(\d+)$/.exec(row.key);
  if (movie) {
    return baseItem({
      id: `m${movie[1]}`,
      name: meta.title || 'Movie',
      type: 'Movie',
      poster: 'tmdb',
      year: meta.year || null,
      runtime: duration / 60,
      aspect: 0.6666667,
      extra,
    });
  }
  const show = /^tmdb:tv:(\d+)$/.exec(row.key);
  if (show) {
    return baseItem({
      id: `t${show[1]}`,
      name: meta.title || 'Show',
      type: 'Series',
      poster: 'tmdb',
      year: meta.year || null,
      aspect: 0.6666667,
      extra: { ...extra, IsFolder: true },
    });
  }
  const ep = /^tmdb:tv:(\d+):s(\d+)e(\d+)$/.exec(row.key);
  if (ep) {
    const showName = seriesLabel(meta.title);
    return baseItem({
      id: `e${ep[1]}s${ep[2]}e${ep[3]}`,
      name: meta.episodeTitle || `Episode ${ep[3]}`,
      type: 'Episode',
      poster: 'tmdb',
      thumb: 'tmdb',
      backdrop: 'tmdb',
      year: meta.year || null,
      runtime: duration / 60,
      aspect: 1.7777778,
      extra: {
        ...extra,
        SeriesId: `t${ep[1]}`,
        SeriesName: showName || meta.title || '',
        ParentIndexNumber: Number(ep[2]),
        IndexNumber: Number(ep[3]),
      },
    });
  }
  const local = /^local:([a-f0-9]{8,40}):(\d+)$/.exec(row.key);
  if (local && typeof deps.localOne === 'function') {
    const item = localJellyItem(deps.localOne(ctx, local[1], Number(local[2])), local[1]);
    if (!item) return null;
    item.UserData = userDataFromRow(row, duration || (item.RunTimeTicks / 10000000), item.Id);
    return item;
  }
  return null;
}

function localFolder(lib) {
  const cover = shelfCoverForKind(lib.kind);
  const poster = cover === 'custom-shows' ? 'xshow' : cover === 'custom-movies' ? 'xmovie' : 'home';
  return baseItem({
    id: `l${lib.id}`,
    name: lib.name || 'Library',
    type: 'CollectionFolder',
    poster,
    thumb: poster,
    cover,
    aspect: 0.6666667,
    extra: { CollectionType: lib.kind === 'tv' ? 'tvshows' : 'movies', IsFolder: true },
  });
}

function localJellyItem(row, libId) {
  if (!row) return null;
  const kind = row.kind || 'movie';
  const poster = typeof row.poster === 'string' && row.poster.startsWith('/') ? row.poster : '';
  const backdrop = typeof row.backdrop === 'string' && row.backdrop.startsWith('/') ? row.backdrop : '';
  const hasArt = !!(poster || backdrop || row.artFile || row.file || row.dir);
  const common = {
    id: localId(libId, row.idx),
    name: row.title || '',
    overview: row.overview || '',
    year: row.year || null,
    poster: poster || (hasArt ? 'local' : ''),
    backdrop,
  };
  if (kind === 'show') {
    return baseItem({
      ...common,
      type: 'Series',
      aspect: 0.6666667,
      extra: { IsFolder: true, CommunityRating: Number(row.rating) > 0 ? Number(row.rating) : undefined },
    });
  }
  if (kind === 'episode') {
    const season = Number(row.s || row.season) || 1;
    const episodeNumber = Number(row.e || row.episode) || null;
    const showName = seriesLabel(row.title);
    return baseItem({
      ...common,
      name: row.epTitle || (episodeNumber ? `Episode ${episodeNumber}` : row.title || ''),
      type: 'Episode',
      thumb: common.poster || common.backdrop || hasArt ? 'local' : '',
      backdrop: common.backdrop || (hasArt ? 'local' : ''),
      runtime: row.runtime,
      aspect: 1.7777778,
      extra: {
        MediaType: 'Video',
        LocationType: 'File',
        SeriesId: localId(libId, row.showIdx),
        SeriesName: showName || row.title || '',
        SeasonId: `${localId(libId, row.showIdx)}s${season}`,
        ParentIndexNumber: season,
        IndexNumber: episodeNumber,
        CommunityRating: Number(row.rating) > 0 ? Number(row.rating) : undefined,
      },
    });
  }
  return baseItem({
    ...common,
    type: 'Movie',
    runtime: row.runtime,
    aspect: 0.6666667,
    childCount: 0,
    extra: {
      MediaType: 'Video',
      LocationType: 'File',
      CommunityRating: Number(row.rating) > 0 ? Number(row.rating) : undefined,
    },
  });
}

function localRows(ctx, libId, showIdx) {
  if (typeof deps.localPage !== 'function') return [];
  const page = deps.localPage(ctx, libId, 0, 500, showIdx);
  return (page && page.items) || [];
}

function episodeOrder(season, episode) {
  return (Number(season) || 0) * 10000 + (Number(episode) || 0);
}

function seriesLabel(title) {
  return String(title || '').replace(/\s*(?:·\s*)?S\d+E\d+.*$/i, '').replace(/\s*[—-]\s*S\d+E\d+.*$/i, '').trim();
}

async function nextUpItems(ctx) {
  const q = ctx.url && ctx.url.searchParams;
  const series = parseItemId((q && (q.get('SeriesId') || q.get('seriesId'))) || '');
  const parent = parseItemId((q && (q.get('ParentId') || q.get('parentId'))) || '');
  const parentRaw = internalItemId(String((q && (q.get('ParentId') || q.get('parentId'))) || ''));
  const rows = typeof deps.jellyfinWatchRows === 'function' ? deps.jellyfinWatchRows(ctx) : [];
  const ranked = [];
  const catalogOk = parentRaw !== 'viewmovies' && (!parent || parent.type !== 'locallib') && (!series || series.type === 'series');
  if (catalogOk && typeof deps.jellyfinNextCatalog === 'function') {
      const catalog = await deps.jellyfinNextCatalog(ctx);
      for (const row of catalog || []) {
        if (series && series.type === 'series' && Number(row.tmdbId) !== series.tmdbId) continue;
        ranked.push({
          at: row.updatedAt || 0,
          item: baseItem({
            id: `e${row.tmdbId}s${row.season}e${row.episode}`,
            name: row.episodeName || `Episode ${row.episode}`,
            overview: row.overview || '',
            type: 'Episode',
            poster: row.tmdbId ? 'tmdb' : '',
            thumb: row.tmdbId ? 'tmdb' : '',
            backdrop: row.tmdbId ? 'tmdb' : '',
            runtime: 0,
            aspect: 1.7777778,
            extra: {
              MediaType: 'Video',
              SeriesId: `t${row.tmdbId}`,
              SeriesName: row.title || '',
              ParentIndexNumber: row.season,
              IndexNumber: row.episode,
            },
          }),
        });
    }
  }
  if (parentRaw === 'viewshows' || parentRaw === 'viewmovies') {
    return ranked.sort((a, b) => b.at - a.at).map((row) => row.item);
  }
  const busy = new Set();
  const byShow = new Map();
  for (const row of rows) {
    const match = /^local:([a-f0-9]{8,40}):(\d+)$/.exec(row && row.key || '');
    if (!match || typeof deps.localOne !== 'function') continue;
    const disk = deps.localOne(ctx, match[1], Number(match[2]));
    if (!disk || disk.kind !== 'episode') continue;
    if (parent && parent.type === 'locallib' && parent.libId !== match[1]) continue;
    const showKey = `${match[1]}:${disk.showIdx}`;
    if (series && series.type === 'local' && (series.libId !== match[1] || series.idx !== Number(disk.showIdx))) continue;
    if (!row.watched && Number(row.position) > 30) { busy.add(showKey); continue; }
    if (!row.watched) continue;
    const order = episodeOrder(disk.s, disk.e);
    const cur = byShow.get(showKey);
    if (!cur || order > cur.order) {
      byShow.set(showKey, { libId: match[1], showIdx: Number(disk.showIdx), order, updatedAt: row.updatedAt || 0 });
    }
  }
  const shows = [...byShow.entries()].filter(([key]) => !busy.has(key))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [, top] of shows) {
    const eps = localRows(ctx, top.libId, top.showIdx)
      .map((row) => ({ row, order: episodeOrder(row.s, row.e) }))
      .filter((ep) => ep.order > top.order)
      .sort((a, b) => a.order - b.order);
    const next = eps[0];
    if (!next) continue;
    const saved = typeof deps.jellyfinWatchGet === 'function'
      ? deps.jellyfinWatchGet(ctx, `local:${top.libId}:${next.row.idx}`) : null;
    if (saved && (saved.watched || Number(saved.position) > 30)) continue;
    const item = localJellyItem(next.row, top.libId);
    if (item) ranked.push({ at: top.updatedAt || 0, item });
  }
  return ranked.sort((a, b) => b.at - a.at).map((row) => row.item);
}

function trimCatalog(ctx, page, view) {
  if (!page || !Array.isArray(page.items)) return page;
  if (view.starts) page.items = page.items.filter((item) => nameStartsWith(item.Name, view.starts));
  if (view.filters.includes('isunplayed') && typeof deps.jellyfinWatchGet === 'function') {
    page.items = page.items.filter((item) => {
      const saved = deps.jellyfinWatchGet(ctx, watchKeyFromId(item.Id));
      return !(saved && saved.watched);
    });
  }
  return page;
}

function localView(view) {
  const named = genreIdsFromNames(view.genres);
  const genreIds = view.genreIds && view.genreIds.length ? view.genreIds : named;
  return {
    sort: localSort(view),
    genreIds,
    years: view.years,
    q: view.search,
    starts: view.starts,
    before: view.before,
    blocked: view.genres.length > 0 && genreIds.length === 0,
  };
}

function watchShelf(ctx, kind, start, limit, view) {
  const rows = typeof deps.jellyfinWatchRows === 'function' ? deps.jellyfinWatchRows(ctx) : [];
  const filtered = rows.filter((row) => {
    if (!row || !savedMatches(row, view.filters)) return false;
    if (kind === 'movie') return /^tmdb:movie:/.test(row.key);
    return /^tmdb:tv:/.test(row.key);
  });
  return {
    items: filtered.slice(start, start + limit).map((row) => itemFromWatchRow(ctx, row)).filter(Boolean),
    total: filtered.length,
    paged: true,
  };
}

async function itemsFor(ctx) {
  const q = ctx.url && ctx.url.searchParams;
  const parent = internalItemId(String((q && (q.get('ParentId') || q.get('parentId'))) || ''));
  const types = String((q && (q.get('IncludeItemTypes') || q.get('includeItemTypes'))) || '').toLowerCase();
  const { start, limit } = windowOf(ctx);
  const view = queryView(ctx);
  const localParent = parseItemId(parent);
  if (localParent && localParent.type === 'locallib' && typeof deps.localPage === 'function') {
    const wanted = localView(view);
    if (wanted.blocked) return { items: [], total: 0, paged: true };
    if (watchFilters(view.filters)) {
      const all = deps.localPage(ctx, localParent.libId, 0, 8000, undefined, { ...wanted, scan: true });
      const rows = ((all && all.items) || []).filter((row) => {
        const saved = typeof deps.jellyfinWatchGet === 'function'
          ? deps.jellyfinWatchGet(ctx, `local:${localParent.libId}:${row.idx}`) : null;
        return savedMatches(saved, view.filters);
      });
      return {
        items: rows.slice(start, start + limit).map((row) => localJellyItem(row, localParent.libId)).filter(Boolean),
        total: rows.length,
        paged: true,
      };
    }
    const page = deps.localPage(ctx, localParent.libId, start, limit, undefined, wanted);
    if (!page) return [];
    return {
      items: page.items.map((row) => localJellyItem(row, localParent.libId)).filter(Boolean),
      total: page.total,
      paged: true,
    };
  }
  if (localParent && localParent.type === 'local') {
    return localRows(ctx, localParent.libId, localParent.idx)
      .map((row) => localJellyItem(row, localParent.libId))
      .filter(Boolean);
  }
  const onlyMarked = view.filters.some((filter) => filter === 'isplayed' || filter === 'isresumable' || filter === 'isfavorite');
  if (!parent && onlyMarked) {
    const wanted = types.split(',').map((part) => part.trim()).filter(Boolean);
    const rows = (typeof deps.jellyfinWatchRows === 'function' ? deps.jellyfinWatchRows(ctx) : [])
      .filter((row) => savedMatches(row, view.filters));
    const items = rows.map((row) => itemFromWatchRow(ctx, row)).filter((item) => {
      if (!item) return false;
      if (!wanted.length) return true;
      return wanted.includes(String(item.Type || '').toLowerCase());
    });
    return { items: items.slice(start, start + limit), total: items.length, paged: true };
  }
  if (!parent && view.search) return searchShelf(ctx, types, start, limit, view);
  if (parent === 'viewmovies' || (!parent && types.includes('movie'))) {
    if (onlyMarked) return watchShelf(ctx, 'movie', start, limit, view);
    return trimCatalog(ctx, await catalogList('movie', start, limit, view), view);
  }
  if (parent === 'viewshows' || (!parent && types.includes('series'))) {
    if (onlyMarked) return watchShelf(ctx, 'series', start, limit, view);
    return trimCatalog(ctx, await catalogList('series', start, limit, view), view);
  }
  const parsed = parseItemId(parent);
  if (parsed && parsed.type === 'series') return seasonsFor(parsed.tmdbId);
  if (parsed && parsed.type === 'season') return episodesFor(parsed.tmdbId, parsed.season);
  if (!parent && !types) {
    const movies = await catalogList('movie', start, limit);
    const shows = await catalogList('series', start, limit);
    return { items: movies.items.concat(shows.items), total: movies.total + shows.total, paged: true };
  }
  return [];
}

async function searchShelf(ctx, types, start, limit, view) {
  const wanted = String(types || '').split(',').map((part) => part.trim()).filter(Boolean);
  const wantMovie = !wanted.length || wanted.includes('movie');
  const wantShow = !wanted.length || wanted.includes('series') || wanted.includes('episode');
  const jobs = [];
  if (wantMovie) jobs.push(catalogList('movie', 0, Math.max(limit, 1), view));
  if (wantShow) jobs.push(catalogList('series', 0, Math.max(limit, 1), view));
  const pages = await Promise.all(jobs);
  let items = [];
  if (typeof deps.localSearch === 'function') {
    for (const hit of deps.localSearch(ctx, view.search, limit) || []) {
      const item = hit && localJellyItem(hit.item, hit.libId);
      if (item) items.push(item);
    }
  }
  for (const page of pages) items = items.concat((page && page.items) || []);
  const seen = new Set();
  items = items.filter((item) => {
    if (!item || !item.Id || seen.has(item.Id)) return false;
    seen.add(item.Id);
    return true;
  });
  return { items: items.slice(start, start + limit), total: items.length, paged: true };
}

async function seasonsFor(tmdbId) {
  const data = await tmdbGet(`/tv/${tmdbId}`);
  const seasons = data && Array.isArray(data.seasons) ? data.seasons : [];
  return seasons.filter((s) => s && Number(s.season_number) > 0).map((s) => baseItem({
    id: `n${tmdbId}s${s.season_number}`,
    name: s.name || `Season ${s.season_number}`,
    type: 'Season',
    overview: s.overview || '',
    year: Number(String(s.air_date || '').slice(0, 4)) || null,
    premiere: s.air_date || null,
    poster: s.poster_path,
    backdrop: data && data.backdrop_path,
    aspect: 0.6666667,
    childCount: Number(s.episode_count) || 0,
    extra: { IsFolder: true, SeriesId: `t${tmdbId}`, SeriesName: data.name || '', IndexNumber: s.season_number },
  }));
}

async function episodesFor(tmdbId, season) {
  const show = await tmdbGet(`/tv/${tmdbId}`);
  const data = await tmdbGet(`/tv/${tmdbId}/season/${season}`);
  const eps = data && Array.isArray(data.episodes) ? data.episodes : [];
  return eps.filter((ep) => ep && ep.episode_number).map((ep) => baseItem({
    id: `e${tmdbId}s${season}e${ep.episode_number}`,
    name: ep.name || `Episode ${ep.episode_number}`,
    type: 'Episode',
    overview: ep.overview || '',
    year: Number(String(ep.air_date || '').slice(0, 4)) || null,
    premiere: ep.air_date || null,
    runtime: ep.runtime,
    poster: ep.still_path || (show && show.poster_path),
    backdrop: (show && show.backdrop_path) || ep.still_path,
    aspect: ep.still_path ? 1.7777778 : 0.6666667,
    extra: {
      MediaType: 'Video',
      LocationType: 'Remote',
      SeriesId: `t${tmdbId}`,
      SeriesName: (show && show.name) || '',
      SeasonId: `n${tmdbId}s${season}`,
      SeasonName: (data && data.name) || `Season ${season}`,
      ParentIndexNumber: season,
      IndexNumber: ep.episode_number,
      ...detailExtra({ vote_average: ep.vote_average, credits: { cast: ep.guest_stars, crew: ep.crew } }, 'tv'),
    },
  }));
}

function warmJellyfinPlay(ctx, itemId, parsed) {
  if (!parsed || (parsed.type !== 'movie' && parsed.type !== 'episode')) return;
  if (typeof deps.jellyfinPrepare !== 'function') return;
  // The details page starts the file search. Play joins it instead of starting over.
  playSpec(parsed).then((spec) => {
    if (!spec) return;
    spec.resumeFrac = resumeFracFor(resumeStartSeconds(ctx, itemId, null, spec.runtime), spec.runtime);
    deps.jellyfinPrepare(ctx, spec);
  }).catch(() => {});
}

// Android TV and Roku send the movie id as MediaSourceId, never our mount id.
// Remember the mount each person last played for each movie, so a second
// PlaybackInfo (audio switch, seek, replay) reuses it instead of a new search.
const lastMount = new Map();
const LAST_MOUNT_CAP = 500;

function lastMountKey(uid, itemId) {
  return `${uid}:${internalItemId(itemId).toLowerCase()}`;
}

function rememberMount(uid, itemId, mountId) {
  if (!uid || !itemId || !mountId) return;
  const key = lastMountKey(uid, itemId);
  lastMount.delete(key);
  lastMount.set(key, String(mountId));
  while (lastMount.size > LAST_MOUNT_CAP) lastMount.delete(lastMount.keys().next().value);
}

function liveStream(mountId, uid) {
  if (!mountId || typeof deps.jellyfinStream !== 'function') return null;
  const found = deps.jellyfinStream(mountId, uid);
  return found && (found.hlsUrl || found.remuxUrl || found.streamUrl) ? found : null;
}

function reusableMount(uid, itemId, sentId) {
  const direct = liveStream(sentId, uid);
  if (direct) return { id: sentId, stream: direct };
  if (!sentId || internalItemId(sentId).toLowerCase() !== internalItemId(itemId).toLowerCase()) return null;
  const key = lastMountKey(uid, itemId);
  const remembered = lastMount.get(key);
  const stream = liveStream(remembered, uid);
  if (stream) return { id: remembered, stream };
  if (remembered) lastMount.delete(key);
  return null;
}

// Real audio rows for a usenet mount, once its tracks are known. Embedded
// captions are left out: those are served through the subtitle map instead.
const mountProbes = new Map();
const PROBE_WAIT_MS = 1500;

async function mountProbe(mountId, uid) {
  if (!mountId) return null;
  if (mountProbes.has(mountId)) return mountProbes.get(mountId);
  if (typeof deps.jellyfinTracks !== 'function') return null;
  let timer;
  const got = await Promise.race([
    Promise.resolve().then(() => deps.jellyfinTracks(mountId, uid)).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), PROBE_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  const video = got && Array.isArray(got.video) ? got.video : [];
  const audio = got && Array.isArray(got.audio) ? got.audio : [];
  if (!video.length && !audio.length) return null;
  const probe = {
    video, audio,
    duration: Number(got.duration) || null,
    format: String(got.format || ''),
    bitRate: Number(got.bitRate) || null,
  };
  mountProbes.set(mountId, probe);
  while (mountProbes.size > 200) mountProbes.delete(mountProbes.keys().next().value);
  return probe;
}

// The TV reads the caption it is showing from DefaultSubtitleStreamIndex.
// Undefined looks like a caption is on when it is off.
function chosenSubtitleIndex(streams, wanted) {
  if (wanted == null || wanted === '') return -1;
  const n = Number(wanted);
  if (!Number.isFinite(n) || n < 0) return -1;
  return (streams || []).some((row) => row.Type === 'Subtitle' && row.Index === n) ? n : -1;
}

async function playSpec(parsed) {
  if (!parsed) return null;
  if (parsed.type === 'movie') {
    const d = await tmdbGet(`/movie/${parsed.tmdbId}`);
    if (!d || !d.title) return null;
    const year = Number(String(d.release_date || '').slice(0, 4)) || undefined;
    return {
      q: `${d.title}${year ? ` ${year}` : ''}`,
      tmdbId: parsed.tmdbId,
      mediaType: 'movie',
      year,
      runtime: Number(d.runtime) || 0,
    };
  }
  if (parsed.type !== 'episode') return null;
  const show = await tmdbGet(`/tv/${parsed.tmdbId}`);
  if (!show || !show.name) return null;
  const season = await tmdbGet(`/tv/${parsed.tmdbId}/season/${parsed.season}`);
  const ep = season && Array.isArray(season.episodes) && season.episodes.find((row) => row.episode_number === parsed.episode);
  const year = Number(String(show.first_air_date || '').slice(0, 4)) || undefined;
  const code = `S${pad2(parsed.season)}E${pad2(parsed.episode)}`;
  const typical = Array.isArray(show.episode_run_time) ? Number(show.episode_run_time[0]) : 0;
  return {
    q: `${show.name} ${code}`,
    tmdbId: parsed.tmdbId,
    mediaType: 'tv',
    season: parsed.season,
    ep: parsed.episode,
    year,
    runtime: Number(ep && ep.runtime) || typical || 0,
  };
}

// An audio or caption switch mid-movie sends PositionTicks instead of
// StartTimeTicks. Without it the movie restarts at 0:00.
function ticksField(body, q, name) {
  const lower = name.toLowerCase();
  const pairs = [
    ...(body && typeof body === 'object' ? Object.entries(body) : []),
    ...(q ? [...q] : []),
  ];
  for (const [key, value] of pairs) {
    if (key.toLowerCase() === lower && Number(value) > 0) return Number(value);
  }
  return 0;
}

function streamStart(ctx, body) {
  const q = ctx && ctx.url && ctx.url.searchParams;
  const ticks = ticksField(body, q, 'StartTimeTicks') || ticksField(body, q, 'PositionTicks');
  if (ticks > 0) return Math.min(10 * 86400, Math.round(ticks / 10000000));
  const start = Number(q && q.get('start'));
  return start > 0 ? Math.min(10 * 86400, Math.round(start)) : 0;
}

// Same fraction the Triboon app sends on Continue Watching. The mount warms
// that minute before the first picture, instead of the opening of the file.
function resumeFracFor(startSeconds, runtimeMinutes) {
  const start = Math.max(0, Number(startSeconds) || 0);
  const runtime = Math.max(0, Number(runtimeMinutes) || 0) * 60;
  if (!(start >= 1) || !(runtime > start + 1)) return 0;
  return Math.min(0.98, start / runtime);
}

// The TV sends 0 when it has no saved minute. A Trakt percent is that minute.
// A real pause already rides in StartTimeTicks, and 0 then means "play from the start".
function traktResumeSeconds(row, runtimeMinutes) {
  if (!row || row.watched) return 0;
  const pos = Math.max(0, Number(row.position) || 0);
  if (pos > 30) return 0;
  const pct = Number(row.traktPct) || 0;
  const runtime = Math.max(0, Number(runtimeMinutes) || 0) * 60;
  if (!(pct > 2) || !(runtime > 60)) return 0;
  return Math.min(Math.floor(runtime * 0.98), Math.round((runtime * pct) / 100));
}

function resumeStartSeconds(ctx, itemId, body, runtimeMinutes) {
  const asked = streamStart(ctx, body);
  if (asked >= 1) return asked;
  const key = watchKeyFromId(itemId);
  if (!key || typeof deps.jellyfinWatchGet !== 'function') return 0;
  return traktResumeSeconds(deps.jellyfinWatchGet(ctx, key), runtimeMinutes);
}

function itemUuid(id) {
  const s = String(id || '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : '';
}

function playPath(payload, startSeconds, audioRel, itemId, durationSeconds) {
  // Short pieces, not one endless file. A phone, TV, or desktop that
  // downloads the whole movie holds it all in memory. The official phone
  // app also refuses anything except an HLS playlist.
  const rel = payload && (payload.hlsUrl || payload.remuxUrl);
  if (!rel) return '';
  let pathOnly = rel.replace(/^https?:\/\/[^/]+/i, '');
  // The phone reads the movie id from the address. A mount id is not one, so
  // play says "source error" and the picture never starts. The address has to
  // end in .m3u8 or the phone will not treat it as a playlist.
  const qpos = pathOnly.indexOf('?');
  const bare = qpos === -1 ? pathOnly : pathOnly.slice(0, qpos);
  if (/\/api\/hls\/[^/]+$/.test(bare)) {
    const movie = itemUuid(itemId);
    const mid = movie ? `/${movie}` : '';
    pathOnly = `${bare}${mid}/master.m3u8${qpos === -1 ? '' : pathOnly.slice(qpos)}`;
  }
  const join = pathOnly.includes('?') ? '&' : '?';
  const start = Math.max(0, Math.round(Number(startSeconds) || 0));
  const audio = Math.max(0, parseInt(audioRel, 10) || 0);
  const dur = Math.round(Number(durationSeconds) || 0);
  const durQ = dur >= 1 && dur <= 10 * 3600 ? `&dur=${dur}` : '';
  // Skip asks again with a new start, because the live pipe itself cannot jump.
  return `${pathOnly}${join}start=${start}&audio=${audio}&audioSafe=1${durQ}`;
}

// A browser following a redirect needs the full address. PlaybackInfo does not.
// The apps add the server themselves.
function servedPlayUrl(ctx, payload, startSeconds, audioRel, itemId, durationSeconds) {
  const rel = playPath(payload, startSeconds, audioRel, itemId, durationSeconds);
  if (!rel) return '';
  if (/^https?:\/\//i.test(rel)) return rel;
  return `${clientAddress(ctx)}${rel}`;
}

// Desktop still wants a web-shaped source. Android TV 0.19 drops that shape
// and crashes the next time you press play.
function desktopWebPlayer(ctx) {
  const hdr = (ctx && ctx.req && ctx.req.headers) || {};
  const blob = `${hdr['user-agent'] || ''} ${hdr.authorization || ''} ${hdr['x-emby-authorization'] || ''}`;
  if (/Android/i.test(blob)) return false;
  if (/Emby/i.test(blob) && /Windows/i.test(blob)) return true;
  if (/JellyfinDesktop/i.test(blob)) return true;
  return /Chrome\/|Edg\/|Firefox\/|Safari\//i.test(blob);
}

// Every app adds the server it already signed into. A full http address gets
// glued on a second time, so Android, Fire TV, and Roku ask for a page that
// is not there. The website, Samsung, and LG do the same glue.
function playUrlForClient(_ctx, payload, startSeconds, audioRel, itemId, durationSeconds) {
  return playPath(payload, startSeconds, audioRel, itemId, durationSeconds);
}

function playLink(ctx, payload, startSeconds) {
  return servedPlayUrl(ctx, payload, startSeconds);
}

async function handleKind(kind, ctx) {
  if (doorStore.getStore() !== ctx) return doorStore.run(ctx, () => handleKind(kind, ctx));
  const { auth, send, readJson, throttled, clientIp, clearLoginThrottle } = deps;
  const cors = jellyfinCors(ctx && ctx.req);
  const brand = ctx && ctx.brand;
  if (ctx && ctx.door === 'emby') {
    if (!embyDoorOpen()) return send(ctx.res, 404, { error: 'not found' });
  } else if (!jellyfinEnabled(deps.settings.get())) {
    return send(ctx.res, 404, { error: 'not found' });
  }
  if (kind === 'emptyPage' && ctx.m && ctx.m[1] && !owns(ctx, ctx.m[1])) {
    return send(ctx.res, 403, { error: 'not your shelf' }, cors);
  }
  if (kind === 'infoPublic') return send(ctx.res, 200, publicInfo(ctx), cors);
  if (kind === 'info') {
    return send(ctx.res, 200, {
      ...publicInfo(ctx),
      HasPendingRestart: false,
      SupportsLibraryMonitor: false,
      CanSelfRestart: false,
    }, cors);
  }
  if (kind === 'systemConfig' || kind === 'startup') {
    return send(ctx.res, 200, {
      ServerName: brand && brand.serverName ? brand.serverName : jellyfinServerName(),
      IsStartupWizardCompleted: true,
      UICulture: 'en-US',
      MetadataCountryCode: 'US',
    }, cors);
  }
  if (kind === 'branding') {
    return send(ctx.res, 200, { LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false }, cors);
  }
  if (kind === 'quickConnect') {
    const enabled = brand ? !!brand.quickConnect : jellyfinQuickConnectOn();
    return send(ctx.res, 200, { Enabled: enabled }, cors);
  }
  if (kind === 'qcInitiate') {
    const enabled = brand ? !!brand.quickConnect : jellyfinQuickConnectOn();
    if (!enabled) return send(ctx.res, 400, { error: 'quick connect is off' }, cors);
    if (throttled(ctx, `jfqc:${clientIp(ctx)}`, { max: 30, windowMs: 600000, lockMs: 600000 })) return;
    // Three minutes: the code is on the TV, and the person approves it in the Triboon app.
    const created = auth.qcCreate((brand && brand.qcLabel) || 'Jellyfin', 3 * 60 * 1000);
    return send(ctx.res, 200, {
      Authenticated: false,
      Secret: created.secret,
      Code: created.code,
      DeviceId: authQuoted(ctx, 'DeviceId'),
      DeviceName: authQuoted(ctx, 'Device'),
      AppName: authQuoted(ctx, 'Client'),
      AppVersion: authQuoted(ctx, 'Version'),
      DateAdded: new Date().toISOString(),
    }, cors);
  }
  if (kind === 'qcConnect') {
    const q = ctx.url && ctx.url.searchParams;
    const secret = q && (q.get('secret') || q.get('Secret'));
    const code = auth.qcFindBySecret(secret);
    const polled = code ? auth.qcPoll(code) : { status: 'expired' };
    if (!polled || polled.status !== 'approved' || !polled.token) {
      return send(ctx.res, 404, { error: 'pending' }, cors);
    }
    const claims = auth.verifyToken(polled.token, 'session');
    const user = claims && auth.getUser(claims.uid);
    if (!user) return send(ctx.res, 404, { error: 'pending' }, cors);
    return send(ctx.res, 200, {
      User: userDto(user),
      AccessToken: polled.token,
      ServerId: doorServerId(),
    }, cors);
  }
  if (kind === 'qcAuthorize') {
    let body = {};
    try { body = await readJson(ctx.req); } catch { body = {}; }
    const q = ctx.url && ctx.url.searchParams;
    const code = String((body && (body.Code || body.code)) || (q && (q.get('code') || q.get('Code'))) || '');
    try {
      auth.qcApprove(code, ctx.user.id);
      return send(ctx.res, 200, { Authenticated: true }, cors);
    } catch (e) {
      return send(ctx.res, 400, { error: e.message || 'code expired or unknown' }, cors);
    }
  }
  if (kind === 'locale') {
    return send(ctx.res, 200, { PreferredMetadataLanguage: 'en', MetadataCountryCode: 'US' }, cors);
  }
  if (kind === 'cultures') {
    return send(ctx.res, 200, [{ Name: 'en-US', DisplayName: 'English', TwoLetterISOLanguageName: 'en' }], cors);
  }
  if (kind === 'me') return send(ctx.res, 200, userDto(ctx.user), cors);
  if (kind === 'userById') {
    if (!owns(ctx, ctx.m[1])) return send(ctx.res, 403, { error: 'not your shelf' }, cors);
    const user = userFromJellyfinId(ctx.m[1]);
    if (!user) return send(ctx.res, 404, { error: 'not found' }, cors);
    return send(ctx.res, 200, userDto(user), cors);
  }
  if (kind === 'nextup') {
    const q = ctx.url && ctx.url.searchParams;
    const userId = (q && (q.get('userId') || q.get('UserId'))) || '';
    if (userId && !owns(ctx, userId)) return send(ctx.res, 403, { error: 'not your shelf' }, cors);
    const items = await nextUpItems(ctx);
    return send(ctx.res, 200, paintPage(ctx, pageOf(items, ctx)), cors);
  }
  if (kind === 'emptyPage') return send(ctx.res, 200, emptyPage(), cors);
  if (kind === 'counts') {
    return send(ctx.res, 200, {
      MovieCount: 0, SeriesCount: 0, EpisodeCount: 0, AlbumCount: 0, SongCount: 0,
    }, cors);
  }
  if (kind === 'displayPrefs') {
    // The phone player requires every one of these. A missing field closes play.
    // Android TV also asks for "livetv" by that name. A 404 there is the error it shows.
    return send(ctx.res, 200, {
      Id: (ctx.m && ctx.m[1]) || 'usersettings',
      Client: 'emby',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      RememberSorting: true,
      RememberIndexing: false,
      ScrollDirection: 'Vertical',
      ShowBackdrop: true,
      ShowSidebar: false,
      PrimaryImageHeight: 0,
      PrimaryImageWidth: 0,
      CustomPrefs: {},
    }, cors);
  }
  if (kind === 'sessions' || kind === 'plugins') return send(ctx.res, 200, [], cors);
  // Roku asks for trailers, extra parts, and the image list right before play.
  // A 404 there leaves it reading a missing list, and the app closes.
  if (kind === 'emptyList') return send(ctx.res, 200, [], cors);
  if (kind === 'emptyItemPage') return send(ctx.res, 200, emptyPage(), cors);
  if (kind === 'encodingConfig') {
    return send(ctx.res, 200, {
      EnableHardwareEncoding: false,
      HardwareAccelerationType: 'none',
      EnableTonemapping: false,
      AllowHevcEncoding: false,
      AllowAv1Encoding: false,
      EnableSubtitleExtraction: true,
    }, cors);
  }
  if (kind === 'resume') {
    const q = ctx.url && ctx.url.searchParams;
    const userId = (ctx.m && ctx.m[1]) || (q && (q.get('userId') || q.get('UserId'))) || '';
    if (userId && !owns(ctx, userId)) return send(ctx.res, 403, { error: 'not your shelf' }, cors);
    const media = listParam(q, ['MediaTypes', 'mediaTypes', 'IncludeItemTypes', 'includeItemTypes'])
      .map((part) => part.toLowerCase());
    const wantsVideo = media.some((part) => part === 'video' || part === 'movie' || part === 'episode' || part === 'series');
    const wantsAudio = media.some((part) => part === 'audio' || part === 'audiobook' || part === 'book' || part === 'music');
    // Continue Listening asks for music. These rows are movies and episodes.
    if (wantsAudio && !wantsVideo) {
      const { start } = windowOf(ctx);
      return send(ctx.res, 200, { Items: [], TotalRecordCount: 0, StartIndex: start }, cors);
    }
    const rows = typeof deps.jellyfinWatchResume === 'function' ? deps.jellyfinWatchResume(ctx) : [];
    const { start, limit } = windowOf(ctx);
    const ranked = [];
    const busyShows = new Set();
    for (const row of rows) {
      const item = itemFromWatchRow(ctx, row);
      if (!item) continue;
      ranked.push({ at: row.updatedAt || 0, item });
      const show = /^tmdb:tv:(\d+)/i.exec(String(row.key || ''));
      if (show) busyShows.add(show[1]);
    }
    // The website puts the next episode on the same Continue Watching row.
    if (typeof deps.jellyfinNextCatalog === 'function') {
      const catalog = await deps.jellyfinNextCatalog(ctx);
      for (const row of catalog || []) {
        if (!row || !row.tmdbId || busyShows.has(String(row.tmdbId))) continue;
        busyShows.add(String(row.tmdbId));
        ranked.push({
          at: row.updatedAt || 0,
          item: baseItem({
            id: `e${row.tmdbId}s${row.season}e${row.episode}`,
            name: row.episodeName || `Episode ${row.episode}`,
            overview: row.overview || '',
            type: 'Episode',
            poster: row.tmdbId ? 'tmdb' : '',
            thumb: row.tmdbId ? 'tmdb' : '',
            backdrop: row.tmdbId ? 'tmdb' : '',
            runtime: 0,
            aspect: 1.7777778,
            extra: {
              MediaType: 'Video',
              SeriesId: `t${row.tmdbId}`,
              SeriesName: row.title || '',
              ParentIndexNumber: row.season,
              IndexNumber: row.episode,
            },
          }),
        });
      }
    }
    ranked.sort((a, b) => b.at - a.at);
    const items = ranked.slice(start, start + limit).map((row) => row.item);
    return send(ctx.res, 200, { Items: items, TotalRecordCount: ranked.length, StartIndex: start }, cors);
  }
  if (kind === 'progress') {
    let body = {};
    try { body = await readJson(ctx.req); } catch { body = {}; }
    const nowPlaying = body && (body.NowPlayingItem || body.nowPlayingItem);
    const itemId = String((body && (body.ItemId || body.itemId)) || (nowPlaying && nowPlaying.Id) || '');
    const key = watchKeyFromId(itemId);
    const ticks = Number(body && (body.PositionTicks || body.positionTicks || body.PlaybackPositionTicks)) || 0;
    const position = progressSeconds(ctx.user && ctx.user.id, itemId, ticks / 10000000);
    if (key && position > 0 && typeof deps.jellyfinWatchSave === 'function') {
      const prev = (typeof deps.jellyfinWatchGet === 'function' && deps.jellyfinWatchGet(ctx, key)) || {};
      let duration = Number(prev.duration) || 0;
      const meta = { ...(prev.meta || {}) };
      if (!duration || !meta.title) {
        const item = await itemById(itemId, ctx);
        if (item) {
          if (!duration && item.RunTimeTicks) duration = Math.round(item.RunTimeTicks / 10000000);
          if (item.SeriesName) meta.title = item.SeriesName;
          else if (!meta.title) meta.title = item.Name || '';
          if (!meta.year && item.ProductionYear) meta.year = item.ProductionYear;
          const parsed = parseItemId(itemId);
          if (parsed && parsed.type === 'movie') { meta.type = 'movie'; meta.tmdbId = parsed.tmdbId; }
          if (parsed && parsed.type === 'episode') { meta.type = 'episode'; meta.tmdbId = parsed.tmdbId; }
        }
      }
      deps.jellyfinWatchSave(ctx, key, { position, duration, meta });
    }
    ctx.res.writeHead(204, { ...cors, 'x-content-type-options': 'nosniff' });
    return ctx.res.end();
  }
  if (kind === 'logout' || kind === 'capabilities' || kind === 'ack') {
    ctx.res.writeHead(204, { ...cors, 'x-content-type-options': 'nosniff' });
    return ctx.res.end();
  }
  if (kind === 'publicUsers') return send(ctx.res, 200, [], cors);
  if (kind === 'views') {
    if (!owns(ctx, ctx.m[1])) return send(ctx.res, 403, { error: 'not your shelf' }, cors);
    const libs = typeof deps.localLibraries === 'function' ? deps.localLibraries(ctx) : [];
    const items = [libraryFolder('viewmovies'), libraryFolder('viewshows'), ...libs.map(localFolder)];
    return send(ctx.res, 200, {
      Items: items,
      TotalRecordCount: items.length,
      StartIndex: 0,
    }, cors);
  }
  if (kind === 'item') {
    const userId = ctx.m[2] ? ctx.m[1] : '';
    const itemId = ctx.m[2] || ctx.m[1];
    if (userId && !owns(ctx, userId)) return send(ctx.res, 403, { error: 'not your shelf' }, cors);
    const item = await itemById(itemId, ctx);
    if (!item) return send(ctx.res, 404, { error: 'not found' }, cors);
    const parsedItem = parseItemId(itemId);
    await attachLocalMedia(ctx, item, parsedItem);
    warmJellyfinPlay(ctx, itemId, parsedItem);
    return send(ctx.res, 200, paintWatch(ctx, item), cors);
  }
  if (kind === 'search') {
    const q = ctx.url && ctx.url.searchParams;
    const term = String((q && (q.get('searchTerm') || q.get('SearchTerm'))) || '').trim();
    const limit = Math.min(50, Math.max(1, queryInt(q, ['Limit', 'limit'], 24)));
    if (term.length < 2) return send(ctx.res, 200, { SearchHints: [], TotalRecordCount: 0 }, cors);
    const view = queryView(ctx);
    view.search = term;
    const found = await searchShelf(ctx, 'movie,series', 0, limit, view);
    const hints = (found.items || []).map((item) => ({
      ItemId: item.Id,
      Id: item.Id,
      Name: item.Name,
      Type: item.Type,
      MediaType: item.MediaType || (item.Type === 'Series' ? 'Video' : 'Video'),
      ProductionYear: item.ProductionYear || null,
      PrimaryImageTag: item.ImageTags && item.ImageTags.Primary || null,
      PrimaryImageAspectRatio: item.PrimaryImageAspectRatio || 0.6666667,
      RunTimeTicks: item.RunTimeTicks || 0,
      IsFolder: item.IsFolder === true || item.Type === 'Series',
    }));
    return send(ctx.res, 200, { SearchHints: hints, TotalRecordCount: found.total || hints.length }, cors);
  }
  if (kind === 'shelf' || kind === 'latest') {
    if (ctx.m && ctx.m[1] && !owns(ctx, ctx.m[1])) return send(ctx.res, 403, { error: 'not your shelf' }, cors);
    const items = await itemsFor(ctx);
    if (kind === 'latest') {
      const list = items && items.paged ? items.items : items;
      const q = ctx.url && ctx.url.searchParams;
      const limit = Math.min(100, Math.max(1, parseInt((q && (q.get('Limit') || q.get('limit'))) || '16', 10) || 16));
      return send(ctx.res, 200, (list || []).slice(0, limit).map((item) => paintWatch(ctx, item)), cors);
    }
    return send(ctx.res, 200, paintPage(ctx, pageOf(items, ctx)), cors);
  }
  if (kind === 'seasons') {
    const parsed = parseItemId(ctx.m[1]);
    if (parsed && parsed.type === 'local') {
      const eps = localRows(ctx, parsed.libId, parsed.idx);
      const nums = [...new Set(eps.map((row) => Number(row.s || row.season) || 1))].sort((a, b) => a - b);
      const items = nums.map((n) => baseItem({
        id: `${localId(parsed.libId, parsed.idx)}s${n}`,
        name: `Season ${n}`,
        type: 'Season',
        poster: 'local',
        aspect: 0.6666667,
        childCount: eps.filter((row) => (Number(row.s || row.season) || 1) === n).length,
        extra: { IsFolder: true, SeriesId: localId(parsed.libId, parsed.idx), IndexNumber: n },
      }));
      return send(ctx.res, 200, pageOf(items, ctx), cors);
    }
    if (!parsed || parsed.type !== 'series') return send(ctx.res, 404, { error: 'not found' }, cors);
    return send(ctx.res, 200, pageOf(await seasonsFor(parsed.tmdbId), ctx), cors);
  }
  if (kind === 'episodes') {
    const parsed = parseItemId(ctx.m[1]);
    if (parsed && parsed.type === 'local') {
      const q = ctx.url && ctx.url.searchParams;
      const seasonId = q && (q.get('seasonId') || q.get('SeasonId'));
      const season = parseItemId(seasonId || '');
      let eps = localRows(ctx, parsed.libId, parsed.idx);
      if (season && season.type === 'localseason') {
        eps = eps.filter((row) => (Number(row.s || row.season) || 1) === season.season);
      }
      return send(ctx.res, 200, pageOf(eps.map((row) => localJellyItem(row, parsed.libId)).filter(Boolean), ctx), cors);
    }
    const q = ctx.url && ctx.url.searchParams;
    const seasonId = q && (q.get('seasonId') || q.get('SeasonId'));
    const season = parseItemId(seasonId || '');
    const n = season && season.type === 'season' ? season.season : (parsed && parsed.season);
    if (!parsed || parsed.type !== 'series') return send(ctx.res, 404, { error: 'not found' }, cors);
    if (!n) {
      const show = await tmdbGet(`/tv/${parsed.tmdbId}`);
      const nums = ((show && show.seasons) || []).map((row) => Number(row.season_number)).filter((row) => row > 0);
      const groups = await Promise.all(nums.map((row) => episodesFor(parsed.tmdbId, row)));
      return send(ctx.res, 200, fullPageOf(groups.flat(), ctx), cors);
    }
    return send(ctx.res, 200, fullPageOf(await episodesFor(parsed.tmdbId, n), ctx), cors);
  }
  if (kind === 'similar') {
    const parsed = parseItemId(ctx.m[1]);
    if (!parsed || (parsed.type !== 'movie' && parsed.type !== 'series')) {
      return send(ctx.res, 200, pageOf([], ctx), cors);
    }
    const path = parsed.type === 'movie'
      ? `/movie/${parsed.tmdbId}/recommendations`
      : `/tv/${parsed.tmdbId}/recommendations`;
    const data = await tmdbGet(path);
    const rows = data && Array.isArray(data.results) ? data.results : [];
    const items = rows.filter((row) => row && row.id).map((row) => (parsed.type === 'movie' ? movieItem(row) : seriesItem(row)));
    return send(ctx.res, 200, pageOf(items, ctx), cors);
  }
  if (kind === 'theme') {
    return send(ctx.res, 200, {
      ThemeVideosResult: emptyPage(),
      ThemeSongsResult: emptyPage(),
      SoundtrackSongsResult: emptyPage(),
    }, cors);
  }
  if (kind === 'image') {
    const parsed = parseItemId(ctx.m[1]);
    const imageKind = String(ctx.m[2] || 'primary');
    const wide = imageKind === 'backdrop';
    let file = '';
    const pipeFile = (imgFile) => {
      let stat;
      try { stat = fs.statSync(imgFile); } catch { return false; }
      const type = imageMime(imgFile);
      ctx.res.writeHead(200, { ...cors, 'content-type': type, 'content-length': stat.size, 'cache-control': 'private, max-age=86400' });
      fs.createReadStream(imgFile).pipe(ctx.res);
      return true;
    };
    const short = internalItemId(ctx.m[1]);
    if (short === 'viewmovies' || short === 'viewshows') {
      const cover = shelfCoverFile(short === 'viewshows' ? 'shows' : 'movies');
      if (cover && pipeFile(cover)) return;
    } else if (parsed && parsed.type === 'locallib') {
      const libs = typeof deps.localLibraries === 'function' ? deps.localLibraries(ctx) : [];
      const lib = libs.find((row) => row.id === parsed.libId);
      const cover = shelfCoverFile(shelfCoverForKind(lib && lib.kind));
      if (cover && pipeFile(cover)) return;
      if (typeof deps.localPage === 'function' && typeof deps.localImage === 'function') {
        const page = deps.localPage(ctx, parsed.libId, 0, 24, null, { sort: 'title.asc' });
        for (const row of (page && page.items) || []) {
          const img = deps.localImage(ctx, parsed.libId, row.idx, wide);
          if (img && img.tmdb) { file = img.tmdb; break; }
          if (img && img.file && pipeFile(img.file)) return;
        }
      }
    } else if (parsed && parsed.type === 'movie') {
      const d = await tmdbGet(`/movie/${parsed.tmdbId}`);
      file = d && (wide ? d.backdrop_path : d.poster_path);
    } else if (parsed && parsed.type === 'series') {
      const d = await tmdbGet(`/tv/${parsed.tmdbId}`);
      file = d && (wide ? d.backdrop_path : d.poster_path);
    } else if (parsed && parsed.type === 'season') {
      const d = await tmdbGet(`/tv/${parsed.tmdbId}/season/${parsed.season}`);
      if (wide) {
        const show = await tmdbGet(`/tv/${parsed.tmdbId}`);
        file = show && show.backdrop_path;
      } else file = d && d.poster_path;
    } else if (parsed && parsed.type === 'episode') {
      const season = await tmdbGet(`/tv/${parsed.tmdbId}/season/${parsed.season}`);
      const ep = season && Array.isArray(season.episodes) && season.episodes.find((row) => row.episode_number === parsed.episode);
      file = (ep && ep.still_path) || '';
      if (!file) {
        const show = await tmdbGet(`/tv/${parsed.tmdbId}`);
        const landscape = wide || imageKind === 'thumb';
        file = (show && (landscape ? (show.backdrop_path || show.poster_path) : (show.poster_path || show.backdrop_path)))
          || (season && season.poster_path)
          || '';
      }
    } else if (parsed && parsed.type === 'person') {
      const d = await tmdbGet(`/person/${parsed.tmdbId}`);
      file = d && d.profile_path;
    } else if (parsed && (parsed.type === 'local' || parsed.type === 'localseason') && typeof deps.localImage === 'function') {
      // Poster tags are loaded by the picture itself, which cannot send the login header.
      // An episode often has no still of its own. Use the show's picture so Continue
      // Watching and Next Up are not a blank TV icon.
      const img = parsed.type === 'local'
        ? episodePicture(ctx, parsed.libId, parsed.idx, wide || imageKind === 'thumb')
        : localPicture(ctx, parsed.libId, parsed.idx, wide);
      if (img && img.tmdb) file = img.tmdb;
      else if (img && img.file) {
        let stat;
        try { stat = fs.statSync(img.file); } catch { return send(ctx.res, 404, { error: 'not found' }, cors); }
        const type = imageMime(img.file);
        ctx.res.writeHead(200, { ...cors, 'content-type': type, 'content-length': stat.size, 'cache-control': 'private, max-age=86400' });
        fs.createReadStream(img.file).pipe(ctx.res);
        return;
      }
    }
    return sendPoster(ctx, cors, file, wide || imageKind === 'thumb');
  }
  if (kind === 'video' && /^true$/i.test(String(queryField(ctx, null, 'static') || ''))) {
    // Direct play: the app wants the original bytes. Hand it our ranged file
    // address, which seeks and reads ahead like our own Android player.
    const uid = ctx.user && ctx.user.id;
    const sentId = String(queryField(ctx, null, 'MediaSourceId') || ctx.m[1]);
    const reused = reusableMount(uid, ctx.m[1], sentId);
    let rel = reused && reused.stream.streamUrl;
    if (!rel) {
      const parsed = parseItemId(ctx.m[1]);
      let played = null;
      if (parsed && parsed.type === 'local' && typeof deps.jellyfinLocalPlay === 'function') {
        played = await deps.jellyfinLocalPlay(ctx, parsed.libId, parsed.idx);
      } else {
        const spec = await playSpec(parsed);
        if (!spec || typeof deps.jellyfinPlay !== 'function') return send(ctx.res, 404, { error: 'not found' }, cors);
        spec.resumeFrac = resumeFracFor(resumeStartSeconds(ctx, ctx.m[1], null, spec.runtime), spec.runtime);
        played = await deps.jellyfinPlay(ctx, spec);
      }
      if (played && played.sent) return;
      if (!played || played.status !== 200) {
        return send(ctx.res, (played && played.status) || 502, (played && played.body) || { error: 'play failed' }, cors);
      }
      rel = played.body && played.body.streamUrl;
      if (rel) rememberMount(uid, ctx.m[1], played.body.id);
    }
    if (!rel) return send(ctx.res, 409, { error: 'not streamable' }, cors);
    debug.log('jellyfin', `original file opened${ctx.req.headers.range ? ` at ${String(ctx.req.headers.range).slice(0, 40)}` : ''} — ${jellyfinAppLabel(ctx)}`);
    const location = /^https?:\/\//i.test(rel) ? rel : `${clientAddress(ctx)}${rel}`;
    ctx.res.writeHead(302, { ...cors, location, 'cache-control': 'no-store' });
    return ctx.res.end();
  }
  if (kind === 'video') {
    const q = ctx.url && ctx.url.searchParams;
    const mountId = q && (q.get('mediaSourceId') || q.get('MediaSourceId'));
    const found = mountId && typeof deps.jellyfinStream === 'function'
      ? deps.jellyfinStream(mountId, ctx.user && ctx.user.id) : null;
    let rel = found && (found.hlsUrl || found.remuxUrl);
    let startRuntime = 0;
    if (!rel) {
      const parsed = parseItemId(ctx.m[1]);
      let played = null;
      if (parsed && parsed.type === 'local' && typeof deps.jellyfinLocalPlay === 'function') {
        played = await deps.jellyfinLocalPlay(ctx, parsed.libId, parsed.idx);
      } else {
        const spec = await playSpec(parsed);
        if (!spec || typeof deps.jellyfinPlay !== 'function') return send(ctx.res, 404, { error: 'not found' }, cors);
        startRuntime = spec.runtime;
        spec.resumeFrac = resumeFracFor(resumeStartSeconds(ctx, ctx.m[1], null, spec.runtime), spec.runtime);
        played = await deps.jellyfinPlay(ctx, spec);
      }
      if (played && played.sent) return;
      if (!played || played.status !== 200) {
        return send(ctx.res, (played && played.status) || 502, (played && played.body) || { error: 'play failed' }, cors);
      }
      rel = played.body && (played.body.hlsUrl || played.body.remuxUrl);
    }
    if (!rel) return send(ctx.res, 503, { error: 'ffmpeg not available on this server' }, cors);
    const start = resumeStartSeconds(ctx, ctx.m[1], null, startRuntime);
    const url = servedPlayUrl(ctx, { hlsUrl: rel }, start, 0, ctx.m[1], startRuntime ? Math.round(Number(startRuntime) * 60) : 0);
    if (!url) return send(ctx.res, 503, { error: 'ffmpeg not available on this server' }, cors);
    ctx.res.writeHead(302, { ...cors, location: url, 'cache-control': 'no-store' });
    return ctx.res.end();
  }
  if (kind === 'subtitle') {
    const parsed = parseItemId(ctx.m[1]);
    const index = parseInt(ctx.m[3], 10);
    let body = parsed && parsed.type === 'local' && typeof deps.localSubtitleBody === 'function'
      ? await deps.localSubtitleBody(ctx, parsed.libId, parsed.idx, index)
      : (typeof deps.jellyfinSubtitleBody === 'function' ? await deps.jellyfinSubtitleBody(ctx, ctx.m[2], index) : null);
    if (body && typeof deps.subtitleOnPlayerClock === 'function') body = await deps.subtitleOnPlayerClock(ctx.m[2], body);
    if (!body) return send(ctx.res, 404, { error: 'not found' }, cors);
    ctx.res.writeHead(200, {
      ...cors,
      'content-type': 'text/vtt; charset=utf-8',
      'content-length': String(Buffer.byteLength(String(body || ''))),
      // Same address for a fresh start and a resume of the same mount, but the
      // clock shift differs. A cached copy would put the words seconds off.
      'cache-control': 'no-store',
    });
    return ctx.res.end(body);
  }
  if (kind === 'bitrate') {
    // The phone measures the line by downloading this blob. A missing page
    // is a 404, and that 404 closes the whole app.
    const q = ctx.url && ctx.url.searchParams;
    const asked = parseInt((q && (q.get('size') || q.get('Size'))) || '102400', 10);
    const size = Math.max(1024, Math.min(Number.isFinite(asked) ? asked : 102400, 1000000));
    const body = Buffer.alloc(size);
    ctx.res.writeHead(200, {
      ...cors,
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'cache-control': 'no-store',
    });
    return ctx.res.end(body);
  }
  if (kind === 'playback') {
    // Press play only. Looking through Movies or Shows never reaches this.
    // A later seek sends the same mount id plus a start time, so we do not
    // open a second usenet download just to move the bar.
    let body = {};
    try { body = await readJson(ctx.req); } catch (e) {
      return send(ctx.res, (e && e.status) || 400, { error: 'bad json' }, cors);
    }
    const parsed = parseItemId(ctx.m[1]);
    const sentId = String(body.MediaSourceId || body.mediaSourceId || '');
    const uid = ctx.user && ctx.user.id;
    const reused = reusableMount(uid, ctx.m[1], sentId);
    let spec = null;
    let playedBody = null;
    if (reused) {
      const { id, stream } = reused;
      playedBody = {
        id, remuxUrl: stream.remuxUrl, hlsUrl: stream.hlsUrl, streamUrl: stream.streamUrl,
        name: stream.name, size: stream.size, sessionId: body.PlaySessionId || id,
      };
      if (parsed && parsed.type === 'local' && typeof deps.localOne === 'function') {
        const row = deps.localOne(ctx, parsed.libId, parsed.idx);
        spec = { runtime: row && row.runtime };
      } else spec = await playSpec(parsed);
    } else if (parsed && parsed.type === 'local') {
      if (typeof deps.jellyfinLocalPlay !== 'function') return send(ctx.res, 404, { error: 'not found' }, cors);
      const played = await deps.jellyfinLocalPlay(ctx, parsed.libId, parsed.idx);
      if (!played || played.status !== 200) {
        return send(ctx.res, (played && played.status) || 502, (played && played.body) || { error: 'play failed' }, cors);
      }
      playedBody = played.body;
      spec = { q: playedBody.candidate && playedBody.candidate.name, runtime: playedBody.runtime };
    } else {
      spec = await playSpec(parsed);
      if (!spec) return send(ctx.res, 404, { error: 'not found' }, cors);
      if (typeof deps.jellyfinPlay !== 'function') return send(ctx.res, 404, { error: 'not found' }, cors);
      spec.resumeFrac = resumeFracFor(resumeStartSeconds(ctx, ctx.m[1], body, spec.runtime), spec.runtime);
      // No waiting on the details warm-up here: play joins a ready or
      // in-flight warm-up itself and races the rest, while the warm-up walks
      // one source at a time in the background lane.
      const played = await deps.jellyfinPlay(ctx, spec);
      if (played && played.sent) return;
      if (!played || played.status !== 200) {
        return send(ctx.res, (played && played.status) || 502, (played && played.body) || { error: 'play failed' }, cors);
      }
      playedBody = played.body;
    }
    rememberMount(uid, ctx.m[1], playedBody && playedBody.id);
    let probe = null;
    if (parsed && parsed.type === 'local' && typeof deps.localMediaInfo === 'function') {
      const info = await deps.localMediaInfo(ctx, parsed.libId, parsed.idx);
      if (info && info.seconds && spec && !spec.runtime) spec.runtime = info.seconds / 60;
      probe = info && info.probe;
    } else if (playedBody && playedBody.id) {
      if (typeof deps.jellyfinSubtitleWarm === 'function') deps.jellyfinSubtitleWarm(ctx, playedBody.id, spec);
      probe = await mountProbe(playedBody.id, uid);
    }
    const sidecars = parsed && parsed.type === 'local' && typeof deps.localSubtitles === 'function'
      ? deps.localSubtitles(ctx, parsed.libId, parsed.idx) : [];
    let streams = streamsWithSubtitles(probe, sidecars).streams;
    if (playedBody && playedBody.id && typeof deps.jellyfinSubtitleStreams === 'function') {
      const more = await deps.jellyfinSubtitleStreams(ctx, playedBody.id, streams.length, spec);
      if (more && more.length) streams = streams.concat(more.map(completeStream));
    }
    const resumeAt = resumeStartSeconds(ctx, ctx.m[1], body, spec && spec.runtime);
    const durationSeconds = spec && spec.runtime ? Math.round(Number(spec.runtime) * 60) : 0;
    const audioIndex = chosenAudioIndex(streams, body.AudioStreamIndex ?? body.audioStreamIndex);
    const audioRel = audioRelFromStreams(streams, audioIndex);
    const desktop = desktopWebPlayer(ctx);
    const check = desktop ? { ok: false, why: 'desktop web player' } : directPlayCheck(ctx, body, probe, {
      streamUrl: playedBody.streamUrl, name: playedBody.name, size: playedBody.size, audioRel,
    });
    const direct = check.ok;
    debug.log('jellyfin', `play ${direct ? 'original file' : 'encoded copy'} — ${check.why} — ${jellyfinAppLabel(ctx)}`);
    // The original file runs on the movie's own clock, so its progress is
    // never shifted by the resume point the way the encoded copy is.
    rememberResumeOrigin(uid, ctx.m[1], direct ? 0 : resumeAt);
    if (typeof deps.jellyfinMarkDirect === 'function') deps.jellyfinMarkDirect(playedBody.id, direct);
    const url = playUrlForClient(ctx, playedBody, resumeAt, audioRel, ctx.m[1], durationSeconds);
    if (!url && !direct) return send(ctx.res, 503, { error: 'ffmpeg not available on this server' }, cors);
    stampSubtitleUrls(streams, ctx.m[1], playedBody.id);
    const runtimeTicks = spec ? ticks(spec.runtime) : 0;
    const hls = url.includes('/api/hls/');
    const source = completeSource({
      // Android TV 0.19 keeps only File sources that are not remote. Anything
      // else is dropped, and pressing play again crashes on the empty list.
      // The id has to be the one the TV sent, or that second press crashes too.
      Id: String(body.MediaSourceId || body.mediaSourceId || playedBody.id),
      Protocol: desktop ? 'Http' : 'File',
      Container: direct ? sourceContainer(probe, playedBody.name) : 'mp4',
      Name: (playedBody.candidate && playedBody.candidate.name) || (spec && spec.q) || '',
      SupportsDirectPlay: direct,
      SupportsDirectStream: false,
      SupportsTranscoding: !!url,
      IsRemote: desktop,
      MediaStreams: streams,
    });
    if (direct) {
      if (playedBody.size) source.Size = playedBody.size;
      const rate = sourceBitRate(probe, playedBody.size);
      if (rate) source.Bitrate = rate;
    }
    if (url) {
      source.TranscodingUrl = url;
      source.TranscodingSubProtocol = hls ? 'hls' : 'http';
      source.TranscodingContainer = 'mp4';
    }
    if (audioIndex != null) source.DefaultAudioStreamIndex = audioIndex;
    const pq = ctx.url && ctx.url.searchParams;
    const askedSub = body.SubtitleStreamIndex ?? body.subtitleStreamIndex
      ?? (pq && (pq.get('SubtitleStreamIndex') ?? pq.get('subtitleStreamIndex')));
    source.DefaultSubtitleStreamIndex = chosenSubtitleIndex(streams, askedSub);
    if (runtimeTicks) source.RunTimeTicks = runtimeTicks;
    if (direct) issueDirectGrant(typeof clientIp === 'function' ? clientIp(ctx) : '', uid, ctx.m[1]);
    return send(ctx.res, 200, { PlaySessionId: playedBody.sessionId, MediaSources: [source] }, cors);
  }
  if (kind === 'segments') {
    // The phone requires the page counts. A list with only Items makes it
    // throw, and the movie page closes.
    return send(ctx.res, 200, emptyPage(), cors);
  }
  if (kind === 'intros') return send(ctx.res, 200, emptyPage(), cors);
  if (kind === 'socket') return send(ctx.res, 426, { error: 'websocket required' }, cors);
  if (kind === 'endpoint') {
    return send(ctx.res, 200, { IsLocal: true, IsInNetwork: true }, cors);
  }
  if (kind === 'filters') {
    const q = ctx.url && ctx.url.searchParams;
    const parent = internalItemId(String((q && (q.get('ParentId') || q.get('parentId'))) || ''));
    const parsed = parseItemId(parent);
    let genres = [];
    let years = [];
    if (parsed && parsed.type === 'locallib' && typeof deps.localFacets === 'function') {
      const facets = deps.localFacets(ctx, parsed.libId) || {};
      genres = (facets.genres || []).map((id) => GENRE_BY_ID[id]).filter(Boolean);
      years = facets.years || [];
    } else if (parent === 'viewmovies' || parent === 'viewshows') {
      const ids = parent === 'viewshows'
        ? [10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37]
        : [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 10770, 37];
      genres = ids.map((id) => GENRE_BY_ID[id]).filter(Boolean);
      const now = new Date().getFullYear();
      years = Array.from({ length: now - 1979 }, (_, i) => now - i);
    }
    return send(ctx.res, 200, { Genres: genres, Tags: [], OfficialRatings: [], Years: years }, cors);
  }
  if (kind === 'favorite' || kind === 'unfavorite' || kind === 'played' || kind === 'unplayed') {
    if (ctx.m && ctx.m[1] && !owns(ctx, ctx.m[1])) return send(ctx.res, 403, { error: 'not your shelf' }, cors);
    const itemId = ctx.m[2];
    const key = watchKeyFromId(itemId);
    const fallback = {
      position: 0,
      duration: 0,
      favorite: kind === 'favorite',
      watched: kind === 'played',
    };
    if (kind === 'unfavorite') fallback.favorite = false;
    if (kind === 'unplayed') fallback.watched = false;
    try {
      if (!key || typeof deps.jellyfinWatchSave !== 'function') {
        return send(ctx.res, 200, userDataFromRow(fallback, 0, itemId), cors);
      }
      const prev = (typeof deps.jellyfinWatchGet === 'function' && deps.jellyfinWatchGet(ctx, key)) || {};
      let item = null;
      try { item = await itemById(itemId, ctx); } catch { item = null; }
      const duration = Number(prev.duration) || (item && item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000000) : 0);
      const meta = { ...(prev.meta || {}) };
      if (item && item.Name && !meta.title) meta.title = item.Name;
      if (item && item.ProductionYear && !meta.year) meta.year = item.ProductionYear;
      const patch = {
        position: Number(prev.position) || 0,
        duration,
        favorite: !!prev.favorite,
        watched: !!prev.watched,
        meta,
      };
      if (kind === 'favorite') patch.favorite = true;
      if (kind === 'unfavorite') patch.favorite = false;
      if (kind === 'played') {
        patch.watched = true;
        if (duration) patch.position = duration;
      }
      if (kind === 'unplayed') {
        patch.watched = false;
        patch.position = 0;
      }
      deps.jellyfinWatchSave(ctx, key, patch);
      return send(ctx.res, 200, userDataFromRow({ ...prev, ...patch }, duration, itemId), cors);
    } catch {
      return send(ctx.res, 200, userDataFromRow(fallback, 0, itemId), cors);
    }
  }
  if (kind === 'login') {
    const body = await readJson(ctx.req);
    const name = String(body.Username || body.username || body.Name || body.name || '');
    const pass = String(body.Pw || body.Password || body.password || '').trim();
    const uname = name.toLowerCase();
    const ip = clientIp(ctx);
    const key = `login:${uname}:${ip}`;
    const acctKey = `login-acct:${uname}`;
    if (throttled(ctx, key, { max: 10, windowMs: 15 * 60000, lockMs: 15 * 60000 })) return;
    if (uname && throttled(ctx, acctKey, { max: 40, windowMs: 15 * 60000, lockMs: 15 * 60000 })) return;
    let result;
    try { result = auth.login(name, pass); }
    catch { return send(ctx.res, 401, { error: 'invalid credentials' }, cors); }
    if (result.twoFactorRequired) {
      clearLoginThrottle(key);
      clearLoginThrottle(acctKey);
      return send(ctx.res, 401, { error: 'sign in to this account in the Triboon app' }, cors);
    }
    clearLoginThrottle(key);
    clearLoginThrottle(acctKey);
    const user = auth.getUser(result.user.id);
    return send(ctx.res, 200, {
      User: userDto(user),
      AccessToken: result.token,
      ServerId: doorServerId(),
    }, cors);
  }
  return send(ctx.res, 404, { error: 'not found' }, cors);
}

const serveJellyfin = (ctx) => handleKind(ctx.kind, ctx);

// The phone asks for a live line at /socket. A plain 404 makes it say the
// server dropped. This line only stays awake. A message cannot start a movie.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SOCKET_CAP = 32;
const jellyfinSockets = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function rejectUpgrade(socket, code, text) {
  debug.fail('jellyfin', `live line refused ${code} ${text}`);
  const reason = { 401: 'Unauthorized', 404: 'Not Found', 426: 'Upgrade Required', 503: 'Service Unavailable' }[code] || 'Bad Request';
  const body = JSON.stringify({ error: text });
  const head = `HTTP/1.1 ${code} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
  try { socket.end(head + body); } catch { try { socket.destroy(); } catch {} }
}

function readWsFrames(buf, onFrame) {
  while (buf.length >= 2) {
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      const big = buf.readBigUInt64BE(2);
      if (big > 65536n) return null;
      len = Number(big);
      offset = 10;
    }
    if (len > 65536) return null;
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return buf;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    buf = buf.subarray(offset + maskLen + len);
    if (!fin || opcode === 0) return null;
    const stop = onFrame(opcode, payload);
    if (stop) return buf;
  }
  return buf;
}

function attachJellyfinSocket(server) {
  if (!server || server.__triboonJellyfinSocket) return;
  server.__triboonJellyfinSocket = true;
  server.on('upgrade', (req, socket, head) => {
    try { openJellyfinSocket(req, socket, head); }
    catch { try { socket.destroy(); } catch {} }
  });
}

function closeJellyfinSockets() {
  const pending = [];
  for (const live of jellyfinSockets) {
    pending.push(new Promise((resolve) => {
      if (live.destroyed) return resolve();
      const timer = setTimeout(resolve, 1000);
      if (typeof timer.unref === 'function') timer.unref();
      live.once('close', () => { clearTimeout(timer); resolve(); });
      if (live.__jfEnding) return;
      live.__jfEnding = true;
      try { live.end(); } catch { resolve(); }
    }));
  }
  return Promise.all(pending);
}

function openJellyfinSocket(req, socket, head) {
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://x').pathname.toLowerCase(); } catch {}
  const embyLine = pathname === '/embywebsocket' || pathname === '/emby/embywebsocket' || pathname === '/emby/socket';
  if (pathname !== '/socket' && !embyLine) {
    socket.destroy();
    return;
  }
  const enabled = embyLine ? !!embySocketOpen() : !!(deps && jellyfinEnabled(deps.settings.get()));
  const token = jellyfinToken(req);
  if (!enabled) return rejectUpgrade(socket, 404, 'not found');
  const claims = token && deps.auth.verifyToken(token, 'session');
  const user = claims && deps.auth.getUser(claims.uid);
  if (!claims || !user || !deps.auth.claimsValidForUser(claims, user)) {
    return rejectUpgrade(socket, 401, 'authentication required');
  }
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    return rejectUpgrade(socket, 426, 'websocket required');
  }
  if (jellyfinSockets.size >= SOCKET_CAP) return rejectUpgrade(socket, 503, 'too many connections');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n`
    + '\r\n'
  );
  jellyfinSockets.add(socket);
  socket.setTimeout(0);
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let alive = Date.now();
  const send = (obj) => {
    if (socket.destroyed || socket.__jfEnding) return;
    try { socket.write(wsFrame(1, JSON.stringify(obj))); } catch {}
  };
  // Android TV reads this the moment the app opens. Without MessageId it
  // closes. The phone on the emulator does not require the id.
  const wsNote = (type, data) => {
    const msg = { MessageType: type, MessageId: crypto.randomUUID() };
    if (data !== undefined) msg.Data = data;
    return msg;
  };
  send(wsNote('ForceKeepAlive', 60));
  const beat = setInterval(() => {
    if (socket.destroyed) return;
    if (Date.now() - alive > 120000) {
      if (!socket.__jfEnding && !socket.destroyed) {
        socket.__jfEnding = true;
        try { socket.end(); } catch {}
      }
      return;
    }
    send(wsNote('KeepAlive'));
  }, 30000);
  if (typeof beat.unref === 'function') beat.unref();
  const cleanup = () => {
    clearInterval(beat);
    jellyfinSockets.delete(socket);
  };
  socket.on('close', cleanup);
  socket.on('error', () => { try { if (!socket.destroyed) socket.destroy(); } catch {} });
  const take = (chunk) => {
    alive = Date.now();
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 1024 * 1024) {
      try { if (!socket.destroyed) socket.destroy(); } catch {}
      return;
    }
    const next = readWsFrames(buf, (opcode, payload) => {
      if (opcode === 8) {
        if (!socket.__jfEnding) {
          socket.__jfEnding = true;
          try { socket.end(wsFrame(8, payload)); } catch {}
        }
        return true;
      }
      if (opcode === 9) {
        try { socket.write(wsFrame(10, payload)); } catch {}
        return false;
      }
      if (opcode !== 1) return false;
      let msg = null;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { return false; }
      if (msg && msg.MessageType === 'KeepAlive') send(wsNote('KeepAlive'));
      return false;
    });
    if (next == null) {
      debug.fail('jellyfin', 'live line closed because the message was not a whole text frame');
      try { if (!socket.destroyed) socket.destroy(); } catch {}
      return;
    }
    buf = next;
  };
  socket.on('data', take);
  if (buf.length) take(Buffer.alloc(0));
}

const JELLYFIN_ROUTES = [
  { m: 'GET', re: /^\/system\/info\/public$/, auth: 'public', kind: 'infoPublic', h: serveJellyfin },
  { m: 'GET', re: /^\/system\/info$/, auth: 'user', kind: 'info', h: serveJellyfin },
  { m: 'GET', re: /^\/system\/endpoint$/, auth: 'user', kind: 'endpoint', h: serveJellyfin },
  { m: 'GET', re: /^\/system\/configuration$/, auth: 'user', kind: 'systemConfig', h: serveJellyfin },
  { m: 'GET', re: /^\/system\/configuration\/encoding$/, auth: 'user', kind: 'encodingConfig', h: serveJellyfin },
  { m: 'GET', re: /^\/startup\/configuration$/, auth: 'public', kind: 'startup', h: serveJellyfin },
  { m: 'GET', re: /^\/branding\/configuration$/, auth: 'public', kind: 'branding', h: serveJellyfin },
  { m: 'GET', re: /^\/quickconnect\/enabled$/, auth: 'public', kind: 'quickConnect', h: serveJellyfin },
  { m: 'POST', re: /^\/quickconnect\/initiate$/, auth: 'public', kind: 'qcInitiate', h: serveJellyfin },
  { m: 'GET', re: /^\/quickconnect\/connect$/, auth: 'public', kind: 'qcConnect', h: serveJellyfin },
  { m: 'POST', re: /^\/quickconnect\/authorize$/, auth: 'user', kind: 'qcAuthorize', h: serveJellyfin },
  { m: 'GET', re: /^\/localization\/options$/, auth: 'public', kind: 'locale', h: serveJellyfin },
  { m: 'GET', re: /^\/localization\/cultures$/, auth: 'public', kind: 'cultures', h: serveJellyfin },
  { m: 'POST', re: /^\/users\/authenticatebyname$/, auth: 'public', kind: 'login', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/me$/, auth: 'user', kind: 'me', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/public$/, auth: 'public', kind: 'publicUsers', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})\/items\/resume$/, auth: 'user', kind: 'resume', h: serveJellyfin },
  { m: 'GET', re: /^\/useritems\/resume$/, auth: 'user', kind: 'resume', h: serveJellyfin },
  { m: 'POST', re: /^\/users\/([a-z0-9-]{4,64})\/favoriteitems\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'favorite', h: serveJellyfin },
  { m: 'DELETE', re: /^\/users\/([a-z0-9-]{4,64})\/favoriteitems\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'unfavorite', h: serveJellyfin },
  { m: 'POST', re: /^\/users\/([a-z0-9-]{4,64})\/playeditems\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'played', h: serveJellyfin },
  { m: 'DELETE', re: /^\/users\/([a-z0-9-]{4,64})\/playeditems\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'unplayed', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})\/items\/latest$/, auth: 'user', kind: 'latest', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})\/items$/, auth: 'user', kind: 'shelf', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})\/items\/([a-z0-9-]{1,64})\/intros$/, auth: 'user', kind: 'intros', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})\/items\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'item', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})\/views$/, auth: 'user', kind: 'views', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})$/, auth: 'user', kind: 'userById', h: serveJellyfin },
  { m: 'GET', re: /^\/userviews$/, auth: 'user', kind: 'views', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/counts$/, auth: 'user', kind: 'counts', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/filters2$/, auth: 'user', kind: 'filters', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/latest$/, auth: 'user', kind: 'latest', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/images\/(primary|backdrop|thumb|logo)(?:\/\d+)?$/, auth: 'public', kind: 'image', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/thememedia$/, auth: 'user', kind: 'theme', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/images$/, auth: 'user', kind: 'emptyList', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/localtrailers$/, auth: 'user', kind: 'emptyList', h: serveJellyfin },
  { m: 'GET', re: /^\/users\/([a-z0-9-]{4,64})\/items\/([a-z0-9-]{1,64})\/localtrailers$/, auth: 'user', kind: 'emptyList', h: serveJellyfin },
  { m: 'GET', re: /^\/videos\/([a-z0-9-]{1,64})\/additionalparts$/, auth: 'user', kind: 'emptyItemPage', h: serveJellyfin },
  { m: 'GET', re: /^\/videos\/([a-z0-9-]{1,64})\/([a-z0-9-]{1,64})\/subtitles\/(\d+)\/stream(?:\.([a-z0-9-]{1,64}))?$/, auth: 'user', kind: 'subtitle', h: serveJellyfin },
  { m: 'GET', re: /^\/videos\/([a-z0-9-]{1,64})\/stream(?:\.[a-z0-9]+)?$/, auth: 'user', kind: 'video', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/similar$/, auth: 'user', kind: 'similar', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/intros$/, auth: 'user', kind: 'intros', h: serveJellyfin },
  { m: 'GET', re: /^\/playback\/bitratetest$/, auth: 'user', kind: 'bitrate', h: serveJellyfin },
  { m: 'GET', re: /^\/mediasegments\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'segments', h: serveJellyfin },
  { m: 'DELETE', re: /^\/videos\/activeencodings$/, auth: 'user', kind: 'ack', h: serveJellyfin },
  { m: 'POST', re: /^\/items\/([a-z0-9-]{1,64})\/playbackinfo$/, auth: 'user', kind: 'playback', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'item', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/?$/, auth: 'user', kind: 'shelf', h: serveJellyfin },
  { m: 'GET', re: /^\/search\/hints$/, auth: 'user', kind: 'search', h: serveJellyfin },
  { m: 'GET', re: /^\/library\/mediafolders$/, auth: 'user', kind: 'views', h: serveJellyfin },
  { m: 'GET', re: /^\/shows\/([a-z0-9-]{1,64})\/seasons$/, auth: 'user', kind: 'seasons', h: serveJellyfin },
  { m: 'GET', re: /^\/shows\/([a-z0-9-]{1,64})\/episodes$/, auth: 'user', kind: 'episodes', h: serveJellyfin },
  { m: 'GET', re: /^\/shows\/nextup$/, auth: 'user', kind: 'nextup', h: serveJellyfin },
  { m: 'GET', re: /^\/livetv\/programs\/recommended$/, auth: 'user', kind: 'emptyPage', h: serveJellyfin },
  { m: 'GET', re: /^\/livetv\/programs$/, auth: 'user', kind: 'emptyPage', h: serveJellyfin },
  { m: 'GET', re: /^\/displaypreferences\/([a-z0-9][a-z0-9-]{0,63})$/, auth: 'user', kind: 'displayPrefs', h: serveJellyfin },
  { m: 'POST', re: /^\/displaypreferences\/([a-z0-9][a-z0-9-]{0,63})$/, auth: 'user', kind: 'ack', h: serveJellyfin },
  { m: 'GET', re: /^\/sessions$/, auth: 'user', kind: 'sessions', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/playing\/progress$/, auth: 'user', kind: 'progress', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/playing\/stopped$/, auth: 'user', kind: 'progress', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/playing$/, auth: 'user', kind: 'progress', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/capabilities\/full$/, auth: 'user', kind: 'capabilities', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/capabilities$/, auth: 'user', kind: 'capabilities', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/logout$/, auth: 'user', kind: 'logout', h: serveJellyfin },
  { m: 'GET', re: /^\/plugins$/, auth: 'user', kind: 'plugins', h: serveJellyfin },
  { m: 'GET', re: /^\/socket$/, auth: 'user', kind: 'socket', h: serveJellyfin },
];

const LOADING_GLYPHS = {
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  o: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  d: ['00001', '00001', '01111', '10001', '10001', '10001', '01110'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  n: ['00000', '00000', '11001', '10101', '10011', '10001', '10001'],
  g: ['00000', '00000', '01111', '10001', '10001', '01111', '00001', '01110'],
};

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
  return out;
}

function paintLoadingCard(raw, w, h) {
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * (w * 3 + 1) + 1 + x * 3;
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
  };
  const cx = 640;
  const cy = 300;
  for (let y = cy - 54; y <= cy + 54; y++) {
    for (let x = cx - 54; x <= cx + 54; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < 36 || d > 48) continue;
      const ang = Math.atan2(y - cy, x - cx);
      if (ang > -0.2 && ang < 1.1) continue;
      put(x, y, 255, 122, 144);
    }
  }
  const text = 'Loading';
  const scale = 8;
  const gap = 10;
  const textW = text.length * (5 * scale + gap) - gap;
  let pen = Math.round((w - textW) / 2);
  const top = 390;
  for (const ch of text) {
    const rows = LOADING_GLYPHS[ch];
    if (!rows) { pen += 5 * scale + gap; continue; }
    rows.forEach((bits, gy) => {
      for (let gx = 0; gx < bits.length; gx++) {
        if (bits[gx] !== '1') continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) put(pen + gx * scale + px, top + gy * scale + py, 255, 255, 255);
        }
      }
    });
    pen += 5 * scale + gap;
  }
}

// A still card the player can show while the movie picture is not ready.
// A black frame looks like the show froze.
function loadingCardPng() {
  const w = 1280;
  const h = 720;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      raw[i] = 20;
      raw[i + 1] = 8;
      raw[i + 2] = 24;
    }
  }
  paintLoadingCard(raw, w, h);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// The first list was the Loading card. The movie has to follow those same
// pieces. Replacing the card with seg00000 makes the desktop player say
// "loading failed", because piece 0 changed under it.
function pictureAfterLoadingCard(count, raw) {
  const n = Math.max(0, Number(count) || 0);
  const text = String(raw || '');
  if (!(n >= 1) || !/seg\d+\.m4s/.test(text)) return text;
  const inf = text.search(/^#EXTINF:/m);
  if (inf < 0) return text;
  const head = text.slice(0, inf);
  const map = (head.match(/#EXT-X-MAP:[^\n]*\n/) || [''])[0];
  const card = loadingHoldPlaylist(n).replace(/\s*$/, '\n');
  return `${card}#EXT-X-DISCONTINUITY\n${map}${text.slice(inf)}`;
}

// A short event list of that card. Each reload is longer, so the phone keeps
// the card on screen instead of treating the wait as a stuck movie.
function loadingHoldPlaylist(count) {
  const n = Math.max(2, Math.min(40, Number(count) || 2));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:EVENT',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
    '#EXT-X-MAP:URI="padinit.mp4"',
  ];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:2.000,', 'pad.m4s');
  return `${lines.join('\n')}\n`;
}

module.exports = {
  JELLYFIN_ROUTES, JELLYFIN_MAX_RANK, bindJellyfin, jellyfinEnabled, isJellyfinPath, jellyfinToken, jellyfinCors, clientAddress,
  setEmbyDoorCheck, setEmbySocketCheck,
  attachJellyfinSocket, closeJellyfinSockets,
  mediaStreamsFromProbe, streamsWithSubtitles, tmdbSort, genreIdsFromNames,
  resumeClockPlaylist, fullTimelinePlaylist, playlistClockShift, rememberResumeOrigin, progressSeconds, resumeFracFor, traktResumeSeconds,
  loadingCardPng, loadingHoldPlaylist, pictureAfterLoadingCard,
  directGrantUser,
};
