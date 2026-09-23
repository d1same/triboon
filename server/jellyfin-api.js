'use strict';
// Jellyfin app door. Off unless settings.jellyfinApps is exactly true.
// Apps sign in with a Triboon name. Movies and episodes come from the catalog.
// Opening a poster does not mount usenet. Pressing play does, through the
// same path as the Triboon Play button, and the link is a start-at-the-beginning
// remux so a player cannot steal connections by reading the end of the file.

const crypto = require('crypto');
const fs = require('fs');

// Phone and TV apps accept a Jellyfin version with three numbers.
// "12.1" has two numbers, so they say the server is unsupported.
const SERVER_VERSION = '10.11.11';
// 480, 576, 720, 1080, 2160. Jellyfin stops at 1080.
const JELLYFIN_MAX_RANK = 3;

const PREFIXES = [
  '/system', '/users', '/useritems', '/userviews', '/items', '/library', '/shows',
  '/displaypreferences', '/quickconnect', '/branding', '/sessions',
  '/plugins', '/startup', '/localization', '/videos', '/livetv',
];

let deps = null;

function bindJellyfin(next) { deps = next; }

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

function jellyfinToken(req) {
  const direct = req.headers['x-emby-token'];
  if (direct) return String(direct).trim();
  const h = String(req.headers.authorization || req.headers['x-emby-authorization'] || '');
  const quoted = h.match(/(?:^|[,\s])Token="([^"]+)"/i);
  if (quoted) return quoted[1];
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  try {
    const key = new URL(req.url || '/', 'http://x').searchParams.get('api_key')
      || new URL(req.url || '/', 'http://x').searchParams.get('ApiKey');
    if (key) return String(key).trim();
  } catch {}
  return null;
}

function jellyfinCors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, X-Emby-Token, X-Emby-Authorization',
  };
}

function emptyPage() {
  return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
}

function firstHeader(value) {
  return String(value || '').split(',')[0].trim();
}

// The address the app should keep using. Behind Unraid, Caddy, or any
// proxy, the public https name wins. A direct house connection stays http.
function clientAddress(ctx) {
  const hdr = (ctx.req && ctx.req.headers) || {};
  let proto = firstHeader(hdr['x-forwarded-proto']).toLowerCase();
  if (proto !== 'https' && proto !== 'http') {
    const match = firstHeader(hdr.forwarded).match(/proto=(https?)/i);
    proto = match ? match[1].toLowerCase() : 'http';
  }
  const host = firstHeader(hdr['x-forwarded-host']) || firstHeader(hdr.host) || 'localhost';
  return `${proto}://${host}`;
}

function publicInfo(ctx) {
  const { auth } = deps;
  return {
    LocalAddress: clientAddress(ctx),
    ServerName: 'Triboon',
    Version: SERVER_VERSION,
    ProductName: 'Jellyfin Server',
    OperatingSystem: 'Triboon',
    Id: serverId(auth.secret),
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
  const { auth } = deps;
  return {
    Name: user.name,
    ServerId: serverId(auth.secret),
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
  return item;
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

function posterUrl(file, kind) {
  const p = String(file || '');
  if (!p.startsWith('/')) return '';
  const size = kind === 'backdrop' ? 'w1280' : 'w500';
  return `https://image.tmdb.org/t/p/${size}${p}`;
}

function ticks(minutes) {
  const n = Number(minutes) || 0;
  if (n <= 0) return 0;
  return Math.round(n * 60 * 10000000);
}

function baseItem(fields) {
  const imageTags = {};
  if (fields.poster) imageTags.Primary = fields.poster === 'local' ? 'disk2' : 'p';
  if (fields.thumb) imageTags.Thumb = 't';
  return stampItem({
    ServerId: serverId(deps.auth.secret),
    ImageTags: imageTags,
    BackdropImageTags: fields.backdrop ? ['b'] : [],
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
function detailExtra(row, kind) {
  const extra = {};
  const genres = named(row.genres);
  if (genres.length) {
    extra.Genres = genres;
    extra.GenreItems = genres.map((name) => ({ Name: name }));
  }
  if (Number(row.vote_average) > 0) extra.CommunityRating = Math.round(Number(row.vote_average) * 10) / 10;
  const cert = certification(row, kind);
  if (cert) extra.OfficialRating = cert;
  const studios = named(row.production_companies);
  if (studios.length) extra.Studios = studios.map((name) => ({ Name: name }));
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
    IsForced: false,
    IsExternal: false,
    IsHearingImpaired: false,
    IsTextSubtitleStream: false,
    SupportsExternalStream: false,
    ...row,
    IsTextSubtitleStream: row.Type === 'Subtitle',
    SupportsExternalStream: row.Type === 'Subtitle' && row.IsExternal !== false,
  };
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
  const genre = view && genreIdsFromNames(view.genres, kind)[0];
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

function libraryFolder(id) {
  if (id === 'viewmovies') return baseItem({ id, name: 'Movies', type: 'CollectionFolder', poster: 'shelf', thumb: 'shelf', aspect: 0.6666667, extra: { CollectionType: 'movies', IsFolder: true } });
  if (id === 'viewshows') return baseItem({ id, name: 'Shows', type: 'CollectionFolder', poster: 'shelf', thumb: 'shelf', aspect: 0.6666667, extra: { CollectionType: 'tvshows', IsFolder: true } });
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
  if (parsed.type === 'local') return `local:${parsed.libId}:${parsed.idx}`;
  return '';
}

function userDataFromRow(row, fallbackSeconds, itemId) {
  const position = Math.max(0, Number(row && row.position) || 0);
  const duration = Math.max(0, Number(row && row.duration) || fallbackSeconds || 0);
  const short = internalItemId(itemId);
  return {
    PlaybackPositionTicks: Math.round(position * 10000000),
    PlayedPercentage: duration ? Math.round((position / duration) * 1000) / 10 : 0,
    PlayCount: row && row.watched ? 1 : 0,
    IsFavorite: !!(row && row.favorite),
    Played: !!(row && row.watched),
    Key: short,
    ItemId: publicItemId(short),
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
    return baseItem({
      id: `e${ep[1]}s${ep[2]}e${ep[3]}`,
      name: meta.title || `Episode ${ep[3]}`,
      type: 'Episode',
      poster: 'tmdb',
      year: meta.year || null,
      runtime: duration / 60,
      aspect: 1.7777778,
      extra: {
        ...extra,
        SeriesId: `t${ep[1]}`,
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
  return baseItem({
    id: `l${lib.id}`,
    name: lib.name || 'Library',
    type: 'CollectionFolder',
    poster: 'local',
    thumb: 'local',
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
    return baseItem({
      ...common,
      type: 'Episode',
      runtime: row.runtime,
      aspect: 1.7777778,
      extra: {
        MediaType: 'Video',
        LocationType: 'File',
        SeriesId: localId(libId, row.showIdx),
        SeasonId: `${localId(libId, row.showIdx)}s${season}`,
        ParentIndexNumber: season,
        IndexNumber: Number(row.e || row.episode) || null,
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

async function nextUpItems(ctx) {
  const q = ctx.url && ctx.url.searchParams;
  const series = parseItemId((q && (q.get('SeriesId') || q.get('seriesId'))) || '');
  const parent = parseItemId((q && (q.get('ParentId') || q.get('parentId'))) || '');
  const parentRaw = internalItemId(String((q && (q.get('ParentId') || q.get('parentId'))) || ''));
  const rows = typeof deps.jellyfinWatchRows === 'function' ? deps.jellyfinWatchRows(ctx) : [];
  const items = [];
  const catalogOk = parentRaw !== 'viewmovies' && (!parent || parent.type !== 'locallib') && (!series || series.type === 'series');
  if (catalogOk && typeof deps.jellyfinNextCatalog === 'function') {
      const catalog = await deps.jellyfinNextCatalog(ctx);
      for (const row of catalog || []) {
        if (series && series.type === 'series' && Number(row.tmdbId) !== series.tmdbId) continue;
        items.push(baseItem({
          id: `e${row.tmdbId}s${row.season}e${row.episode}`,
          name: `Episode ${row.episode}`,
          type: 'Episode',
          poster: row.tmdbId ? 'tmdb' : '',
          runtime: 0,
          aspect: 1.7777778,
          extra: {
            MediaType: 'Video',
            SeriesId: `t${row.tmdbId}`,
            SeriesName: row.title || '',
            ParentIndexNumber: row.season,
            IndexNumber: row.episode,
          },
        }));
    }
  }
  if (parentRaw === 'viewshows' || parentRaw === 'viewmovies') return items;
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
    if (item) items.push(item);
  }
  return items;
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
  const genreIds = genreIdsFromNames(view.genres);
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

function streamStart(ctx, body) {
  const q = ctx && ctx.url && ctx.url.searchParams;
  const ticks = Number((body && (body.StartTimeTicks || body.startTimeTicks))
    || (q && (q.get('StartTimeTicks') || q.get('startTimeTicks'))) || 0);
  if (ticks > 0) return Math.min(10 * 86400, Math.round(ticks / 10000000));
  const start = Number(q && q.get('start'));
  return start > 0 ? Math.min(10 * 86400, Math.round(start)) : 0;
}

function playPath(payload, startSeconds, audioRel) {
  // Short pieces, not one endless file. A phone, TV, or desktop that
  // downloads the whole movie holds it all in memory.
  const rel = payload && (payload.hlsUrl || payload.remuxUrl);
  if (!rel) return '';
  let pathOnly = rel.replace(/^https?:\/\/[^/]+/i, '');
  // The TV app only uses its show player when the address ends in .m3u8.
  // Without that, it tries to read the playlist as a normal movie and errors.
  const qpos = pathOnly.indexOf('?');
  const bare = qpos === -1 ? pathOnly : pathOnly.slice(0, qpos);
  if (/\/api\/hls\/[^/]+$/.test(bare)) {
    pathOnly = `${bare}/master.m3u8${qpos === -1 ? '' : pathOnly.slice(qpos)}`;
  }
  const join = pathOnly.includes('?') ? '&' : '?';
  const start = Math.max(0, Math.round(Number(startSeconds) || 0));
  const audio = Math.max(0, parseInt(audioRel, 10) || 0);
  // A relative path lets the app prefix its server. Skip then asks again with
  // a new start, because the live pipe itself cannot jump.
  return `${pathOnly}${join}start=${start}&audio=${audio}&audioSafe=1`;
}

function playLink(ctx, payload, startSeconds) {
  const rel = playPath(payload, startSeconds);
  if (!rel) return '';
  return `${clientAddress(ctx)}${rel}`;
}

async function handleKind(kind, ctx) {
  const { auth, send, readJson, throttled, clientIp, clearLoginThrottle } = deps;
  const cors = jellyfinCors();
  if (!jellyfinEnabled(deps.settings.get())) return send(ctx.res, 404, { error: 'not found' });
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
      ServerName: 'Triboon',
      IsStartupWizardCompleted: true,
      UICulture: 'en-US',
      MetadataCountryCode: 'US',
    }, cors);
  }
  if (kind === 'branding') {
    return send(ctx.res, 200, { LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false }, cors);
  }
  if (kind === 'quickConnect') return send(ctx.res, 200, { Enabled: false }, cors);
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
    return send(ctx.res, 200, {
      Id: 'usersettings', SortBy: 'SortName', SortOrder: 'Ascending', CustomPrefs: {},
    }, cors);
  }
  if (kind === 'sessions' || kind === 'plugins') return send(ctx.res, 200, [], cors);
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
    const items = rows.slice(start, start + limit).map((row) => itemFromWatchRow(ctx, row)).filter(Boolean);
    return send(ctx.res, 200, { Items: items, TotalRecordCount: rows.length, StartIndex: start }, cors);
  }
  if (kind === 'progress') {
    let body = {};
    try { body = await readJson(ctx.req); } catch { body = {}; }
    const nowPlaying = body && (body.NowPlayingItem || body.nowPlayingItem);
    const itemId = String((body && (body.ItemId || body.itemId)) || (nowPlaying && nowPlaying.Id) || '');
    const key = watchKeyFromId(itemId);
    const ticks = Number(body && (body.PositionTicks || body.positionTicks || body.PlaybackPositionTicks)) || 0;
    const position = Math.max(0, Math.round(ticks / 10000000));
    if (key && position > 0 && typeof deps.jellyfinWatchSave === 'function') {
      const prev = (typeof deps.jellyfinWatchGet === 'function' && deps.jellyfinWatchGet(ctx, key)) || {};
      let duration = Number(prev.duration) || 0;
      const meta = { ...(prev.meta || {}) };
      if (!duration || !meta.title) {
        const item = await itemById(itemId, ctx);
        if (item) {
          if (!duration && item.RunTimeTicks) duration = Math.round(item.RunTimeTicks / 10000000);
          if (!meta.title) meta.title = item.Name || '';
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
    await attachLocalMedia(ctx, item, parseItemId(itemId));
    return send(ctx.res, 200, paintWatch(ctx, item), cors);
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
      const nums = ((show && show.seasons) || []).map((row) => Number(row.season_number)).filter((row) => row > 0).slice(0, 12);
      const groups = await Promise.all(nums.map((row) => episodesFor(parsed.tmdbId, row)));
      return send(ctx.res, 200, pageOf(groups.flat(), ctx), cors);
    }
    return send(ctx.res, 200, pageOf(await episodesFor(parsed.tmdbId, n), ctx), cors);
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
      const type = /\.png$/i.test(imgFile) ? 'image/png' : /\.webp$/i.test(imgFile) ? 'image/webp' : 'image/jpeg';
      ctx.res.writeHead(200, { ...cors, 'content-type': type, 'content-length': stat.size, 'cache-control': 'private, max-age=86400' });
      fs.createReadStream(imgFile).pipe(ctx.res);
      return true;
    };
    const short = internalItemId(ctx.m[1]);
    if (short === 'viewmovies' || short === 'viewshows') {
      const discover = short === 'viewmovies'
        ? '/discover/movie?sort_by=popularity.desc&include_adult=false&vote_count.gte=300'
        : '/discover/tv?sort_by=popularity.desc&include_adult=false&vote_count.gte=100';
      const data = await tmdbGet(discover);
      const hit = data && Array.isArray(data.results) && data.results.find((row) => row && (wide ? row.backdrop_path : row.poster_path));
      file = hit && (wide ? (hit.backdrop_path || hit.poster_path) : hit.poster_path);
    } else if (parsed && parsed.type === 'locallib' && typeof deps.localPage === 'function' && typeof deps.localImage === 'function') {
      const page = deps.localPage(ctx, parsed.libId, 0, 24, null, { sort: 'title.asc' });
      for (const row of (page && page.items) || []) {
        const img = deps.localImage(ctx, parsed.libId, row.idx, wide);
        if (img && img.tmdb) { file = img.tmdb; break; }
        if (img && img.file && pipeFile(img.file)) return;
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
      const d = await tmdbGet(`/tv/${parsed.tmdbId}/season/${parsed.season}`);
      const ep = d && Array.isArray(d.episodes) && d.episodes.find((row) => row.episode_number === parsed.episode);
      file = (ep && ep.still_path) || '';
    } else if (parsed && parsed.type === 'person') {
      const d = await tmdbGet(`/person/${parsed.tmdbId}`);
      file = d && d.profile_path;
    } else if (parsed && (parsed.type === 'local' || parsed.type === 'localseason') && typeof deps.localImage === 'function') {
      // Poster tags are loaded by the picture itself, which cannot send the login header.
      const img = deps.localImage(ctx, parsed.libId, parsed.idx, wide);
      if (img && img.tmdb) file = img.tmdb;
      else if (img && img.file) {
        let stat;
        try { stat = fs.statSync(img.file); } catch { return send(ctx.res, 404, { error: 'not found' }, cors); }
        const type = /\.png$/i.test(img.file) ? 'image/png' : /\.webp$/i.test(img.file) ? 'image/webp' : 'image/jpeg';
        ctx.res.writeHead(200, { ...cors, 'content-type': type, 'content-length': stat.size, 'cache-control': 'private, max-age=86400' });
        fs.createReadStream(img.file).pipe(ctx.res);
        return;
      }
    }
    const loc = posterUrl(file, wide ? 'backdrop' : 'poster');
    if (!loc) return send(ctx.res, 404, { error: 'not found' }, cors);
    ctx.res.writeHead(302, { ...cors, location: loc, 'cache-control': 'public, max-age=86400' });
    return ctx.res.end();
  }
  if (kind === 'video') {
    const q = ctx.url && ctx.url.searchParams;
    const mountId = q && (q.get('mediaSourceId') || q.get('MediaSourceId'));
    const found = mountId && typeof deps.jellyfinStream === 'function'
      ? deps.jellyfinStream(mountId, ctx.user && ctx.user.id) : null;
    let rel = found && (found.hlsUrl || found.remuxUrl);
    if (!rel) {
      const parsed = parseItemId(ctx.m[1]);
      let played = null;
      if (parsed && parsed.type === 'local' && typeof deps.jellyfinLocalPlay === 'function') {
        played = await deps.jellyfinLocalPlay(ctx, parsed.libId, parsed.idx);
      } else {
        const spec = await playSpec(parsed);
        if (!spec || typeof deps.jellyfinPlay !== 'function') return send(ctx.res, 404, { error: 'not found' }, cors);
        played = await deps.jellyfinPlay(ctx, spec);
      }
      if (played && played.sent) return;
      if (!played || played.status !== 200) {
        return send(ctx.res, (played && played.status) || 502, (played && played.body) || { error: 'play failed' }, cors);
      }
      rel = played.body && (played.body.hlsUrl || played.body.remuxUrl);
    }
    if (!rel) return send(ctx.res, 503, { error: 'ffmpeg not available on this server' }, cors);
    const host = (ctx.req.headers && ctx.req.headers.host) || 'localhost';
    const abs = rel.startsWith('http') ? rel : `http://${host}${rel}`;
    const join = abs.includes('?') ? '&' : '?';
    const start = streamStart(ctx, null);
    ctx.res.writeHead(302, { location: `${abs}${join}start=${start}&audio=0&audioSafe=1`, 'cache-control': 'no-store' });
    return ctx.res.end();
  }
  if (kind === 'subtitle') {
    const parsed = parseItemId(ctx.m[1]);
    const index = parseInt(ctx.m[3], 10);
    const body = parsed && parsed.type === 'local' && typeof deps.localSubtitleBody === 'function'
      ? await deps.localSubtitleBody(ctx, parsed.libId, parsed.idx, index)
      : (typeof deps.jellyfinSubtitleBody === 'function' ? await deps.jellyfinSubtitleBody(ctx, ctx.m[2], index) : null);
    if (!body) return send(ctx.res, 404, { error: 'not found' }, cors);
    ctx.res.writeHead(200, {
      ...cors,
      'content-type': 'text/vtt; charset=utf-8',
      'cache-control': 'private, max-age=3600',
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
    const mountId = String(body.MediaSourceId || body.mediaSourceId || '');
    const uid = ctx.user && ctx.user.id;
    const reused = mountId && typeof deps.jellyfinStream === 'function' ? deps.jellyfinStream(mountId, uid) : '';
    let spec = null;
    let playedBody = null;
    if (reused && (reused.hlsUrl || reused.remuxUrl)) {
      playedBody = { id: mountId, remuxUrl: reused.remuxUrl, hlsUrl: reused.hlsUrl, sessionId: body.PlaySessionId || mountId };
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
      const played = await deps.jellyfinPlay(ctx, spec);
      if (played && played.sent) return;
      if (!played || played.status !== 200) {
        return send(ctx.res, (played && played.status) || 502, (played && played.body) || { error: 'play failed' }, cors);
      }
      playedBody = played.body;
    }
    let probe = null;
    if (parsed && parsed.type === 'local' && typeof deps.localMediaInfo === 'function') {
      const info = await deps.localMediaInfo(ctx, parsed.libId, parsed.idx);
      if (info && info.seconds && spec && !spec.runtime) spec.runtime = info.seconds / 60;
      probe = info && info.probe;
    }
    const sidecars = parsed && parsed.type === 'local' && typeof deps.localSubtitles === 'function'
      ? deps.localSubtitles(ctx, parsed.libId, parsed.idx) : [];
    let streams = streamsWithSubtitles(probe, sidecars).streams;
    if (playedBody && playedBody.id && typeof deps.jellyfinSubtitleStreams === 'function') {
      const more = await deps.jellyfinSubtitleStreams(ctx, playedBody.id, streams.length, spec);
      if (more && more.length) streams = streams.concat(more.map(completeStream));
    }
    const url = playPath(playedBody, streamStart(null, body), audioRelFromStreams(streams, body.AudioStreamIndex || body.audioStreamIndex));
    if (!url) return send(ctx.res, 503, { error: 'ffmpeg not available on this server' }, cors);
    const runtimeTicks = spec ? ticks(spec.runtime) : 0;
    const hls = url.includes('/api/hls/');
    const source = completeSource({
      Id: playedBody.id,
      Protocol: 'Http',
      Container: 'mp4',
      Name: (playedBody.candidate && playedBody.candidate.name) || (spec && spec.q) || '',
      SupportsDirectPlay: false,
      SupportsDirectStream: false,
      SupportsTranscoding: true,
      IsRemote: true,
      TranscodingUrl: url,
      TranscodingSubProtocol: hls ? 'hls' : 'http',
      TranscodingContainer: 'mp4',
      MediaStreams: streams,
    });
    if (runtimeTicks) source.RunTimeTicks = runtimeTicks;
    return send(ctx.res, 200, { PlaySessionId: playedBody.sessionId, MediaSources: [source] }, cors);
  }
  if (kind === 'intros') return send(ctx.res, 200, emptyPage(), cors);
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
    if (!key || typeof deps.jellyfinWatchSave !== 'function') return send(ctx.res, 404, { error: 'not found' }, cors);
    const prev = (typeof deps.jellyfinWatchGet === 'function' && deps.jellyfinWatchGet(ctx, key)) || {};
    const item = await itemById(itemId, ctx);
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
      ServerId: serverId(auth.secret),
    }, cors);
  }
  return send(ctx.res, 404, { error: 'not found' }, cors);
}

const serveJellyfin = (ctx) => handleKind(ctx.kind, ctx);

const JELLYFIN_ROUTES = [
  { m: 'GET', re: /^\/system\/info\/public$/, auth: 'public', kind: 'infoPublic', h: serveJellyfin },
  { m: 'GET', re: /^\/system\/info$/, auth: 'user', kind: 'info', h: serveJellyfin },
  { m: 'GET', re: /^\/system\/endpoint$/, auth: 'user', kind: 'endpoint', h: serveJellyfin },
  { m: 'GET', re: /^\/system\/configuration$/, auth: 'user', kind: 'systemConfig', h: serveJellyfin },
  { m: 'GET', re: /^\/startup\/configuration$/, auth: 'public', kind: 'startup', h: serveJellyfin },
  { m: 'GET', re: /^\/branding\/configuration$/, auth: 'public', kind: 'branding', h: serveJellyfin },
  { m: 'GET', re: /^\/quickconnect\/enabled$/, auth: 'public', kind: 'quickConnect', h: serveJellyfin },
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
  { m: 'GET', re: /^\/videos\/([a-z0-9-]{1,64})\/([a-z0-9-]{1,64})\/subtitles\/(\d+)\/stream(?:\.([a-z0-9-]{1,64}))?$/, auth: 'user', kind: 'subtitle', h: serveJellyfin },
  { m: 'GET', re: /^\/videos\/([a-z0-9-]{1,64})\/stream(?:\.[a-z0-9]+)?$/, auth: 'user', kind: 'video', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/similar$/, auth: 'user', kind: 'similar', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})\/intros$/, auth: 'user', kind: 'intros', h: serveJellyfin },
  { m: 'POST', re: /^\/items\/([a-z0-9-]{1,64})\/playbackinfo$/, auth: 'user', kind: 'playback', h: serveJellyfin },
  { m: 'GET', re: /^\/items\/([a-z0-9-]{1,64})$/, auth: 'user', kind: 'item', h: serveJellyfin },
  { m: 'GET', re: /^\/items$/, auth: 'user', kind: 'shelf', h: serveJellyfin },
  { m: 'GET', re: /^\/library\/mediafolders$/, auth: 'user', kind: 'views', h: serveJellyfin },
  { m: 'GET', re: /^\/shows\/([a-z0-9-]{1,64})\/seasons$/, auth: 'user', kind: 'seasons', h: serveJellyfin },
  { m: 'GET', re: /^\/shows\/([a-z0-9-]{1,64})\/episodes$/, auth: 'user', kind: 'episodes', h: serveJellyfin },
  { m: 'GET', re: /^\/shows\/nextup$/, auth: 'user', kind: 'nextup', h: serveJellyfin },
  { m: 'GET', re: /^\/livetv\/programs$/, auth: 'user', kind: 'emptyPage', h: serveJellyfin },
  { m: 'GET', re: /^\/displaypreferences\/usersettings$/, auth: 'user', kind: 'displayPrefs', h: serveJellyfin },
  { m: 'GET', re: /^\/sessions$/, auth: 'user', kind: 'sessions', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/playing\/progress$/, auth: 'user', kind: 'progress', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/playing\/stopped$/, auth: 'user', kind: 'progress', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/playing$/, auth: 'user', kind: 'ack', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/capabilities\/full$/, auth: 'user', kind: 'capabilities', h: serveJellyfin },
  { m: 'POST', re: /^\/sessions\/logout$/, auth: 'user', kind: 'logout', h: serveJellyfin },
  { m: 'GET', re: /^\/plugins$/, auth: 'user', kind: 'plugins', h: serveJellyfin },
];

module.exports = {
  JELLYFIN_ROUTES, JELLYFIN_MAX_RANK, bindJellyfin, jellyfinEnabled, isJellyfinPath, jellyfinToken, jellyfinCors,
  mediaStreamsFromProbe, streamsWithSubtitles, tmdbSort, genreIdsFromNames,
};
