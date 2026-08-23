'use strict';
// Durable per-account watch ledger for the Settings Dashboard.
// Hours are actual play seconds (pause/seek do not invent time). Movies / streak / recent
// stay finish-only. Trakt imports must never write here.

const DEDUPE_MS = 6 * 60 * 60 * 1000;
const PLAY_MERGE_MS = 15 * 60 * 1000;
const MAX_PLAY_FLUSH = 4 * 3600;
const MAX_EVENTS = 4000;
const RANGES = new Set(['week', 'month', 'year', 'all']);

function classify(key, meta) {
  const k = String(key || '');
  const type = String((meta && meta.type) || '').toLowerCase();
  if (!k) return null;
  if (k.startsWith('live:') || type === 'live' || type === 'channel') return null;
  if (k.startsWith('ytm:') || k.startsWith('music:') || type === 'music' || type === 'song') return null;
  if (k.startsWith('audible:') || type === 'audiobook' || type === 'pubaudio') return null;
  const movie = /^tmdb:movie:(\d+)$/.exec(k);
  if (movie) return { kind: 'movie', showKey: null };
  const ep = /^tmdb:tv:(\d+):s(\d+)e(\d+)$/i.exec(k);
  if (ep) return { kind: 'episode', showKey: `tmdb:tv:${ep[1]}` };
  if (type === 'movie' || type === 'local-movie') return { kind: 'movie', showKey: null };
  if (type === 'local') {
    if (/:s\d+e\d+$/i.test(k)) {
      return { kind: 'episode', showKey: k.replace(/:s\d+e\d+$/i, '') };
    }
    return { kind: 'movie', showKey: null };
  }
  if (type === 'episode' || type === 'local-tv') {
    const showKey = (meta && (meta.showKey || meta.showId))
      ? String(meta.showKey || `tmdb:tv:${meta.showId}`)
      : (k.replace(/:s\d+e\d+$/i, '') !== k ? k.replace(/:s\d+e\d+$/i, '') : null);
    return { kind: 'episode', showKey };
  }
  // Bare show keys are a catalog id, not a finish.
  if (/^tmdb:tv:\d+$/.test(k) || type === 'tv' || type === 'show') return null;
  return null;
}

function clip(s, n) {
  return String(s || '').trim().slice(0, n);
}

function eventsForUser(doc, userId) {
  const uid = String(userId);
  const users = (doc && doc.users) || {};
  const list = users[uid] && users[uid].events;
  return Array.isArray(list) ? list : [];
}

function rangeStart(range, now) {
  if (range === 'week') return now - 7 * 86400000;
  if (range === 'month') return now - 30 * 86400000;
  if (range === 'year') return now - 365 * 86400000;
  return 0;
}

function recordFinish(store, { userId, key, meta, duration, at } = {}) {
  const cls = classify(key, meta);
  if (!cls || !userId || !store) return false;
  const now = Number(at) || Date.now();
  const uid = String(userId);
  const dur = Math.max(0, Math.round(Number(duration) || 0));
  const title = clip((meta && (meta.showTitle || meta.show || meta.title || meta.name)) || '', 180);
  const poster = clip((meta && (meta.poster || meta.art)) || '', 400);
  store.update('watchStats', { users: {} }, (doc) => {
    if (!doc.users) doc.users = {};
    const prev = doc.users[uid] || { events: [] };
    const events = Array.isArray(prev.events) ? prev.events : [];
    const last = events.findLast ? events.findLast((e) => e && e.key === key && e.source !== 'play')
      : [...events].reverse().find((e) => e && e.key === key && e.source !== 'play');
    if (last && (now - last.at) < DEDUPE_MS) return doc;
    events.push({
      at: now,
      key,
      kind: cls.kind,
      showKey: cls.showKey,
      duration: dur,
      title,
      poster,
      source: 'finish',
    });
    while (events.length > MAX_EVENTS) events.shift();
    doc.users[uid] = { events };
    return doc;
  });
  return true;
}

function recordPlayTime(store, { userId, key, meta, playedSeconds, at } = {}) {
  const cls = classify(key, meta);
  const played = Math.min(MAX_PLAY_FLUSH, Math.max(0, Math.round(Number(playedSeconds) || 0)));
  if (!cls || !userId || !store || played < 1) return false;
  const now = Number(at) || Date.now();
  const uid = String(userId);
  const title = clip((meta && (meta.showTitle || meta.show || meta.title || meta.name)) || '', 180);
  const poster = clip((meta && (meta.poster || meta.art)) || '', 400);
  store.update('watchStats', { users: {} }, (doc) => {
    if (!doc.users) doc.users = {};
    const prev = doc.users[uid] || { events: [] };
    const events = Array.isArray(prev.events) ? prev.events : [];
    const last = events.findLast ? events.findLast((e) => e && e.key === key && e.source === 'play')
      : [...events].reverse().find((e) => e && e.key === key && e.source === 'play');
    if (last && (now - last.at) < PLAY_MERGE_MS) {
      last.duration = Math.max(0, Number(last.duration) || 0) + played;
      last.at = now;
      if (title) last.title = title;
      if (poster) last.poster = poster;
    } else {
      events.push({
        at: now,
        key,
        kind: cls.kind,
        showKey: cls.showKey,
        duration: played,
        title,
        poster,
        source: 'play',
      });
    }
    while (events.length > MAX_EVENTS) events.shift();
    doc.users[uid] = { events };
    return doc;
  });
  return true;
}

function mediaKeyFromWatchStoreKey(storeKey, userId) {
  const prefix = `${userId}:`;
  if (!String(storeKey).startsWith(prefix)) return null;
  const rest = String(storeKey).slice(prefix.length);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  return rest.slice(i + 1);
}

function countWatched(watchAll, userId) {
  const movies = new Set();
  const episodes = new Set();
  const shows = new Set();
  const titles = new Map();
  for (const [sk, row] of Object.entries(watchAll || {})) {
    if (!row || !row.watched || row.hidden) continue;
    const key = mediaKeyFromWatchStoreKey(sk, userId);
    if (!key) continue;
    const cls = classify(key, row.meta);
    if (!cls) continue;
    const title = clip((row.meta && (row.meta.showTitle || row.meta.show || row.meta.title || row.meta.name)) || key, 180);
    if (cls.kind === 'movie') {
      movies.add(key);
      const prev = titles.get(key) || { key, title, kind: 'movie', count: 0, seconds: 0, at: 0 };
      prev.count += 1;
      prev.seconds += Math.max(0, row.duration || 0);
      prev.at = Math.max(prev.at || 0, row.updatedAt || 0);
      if (title) prev.title = title;
      titles.set(key, prev);
    } else {
      episodes.add(key);
      const id = cls.showKey || key;
      if (cls.showKey) shows.add(cls.showKey);
      const prev = titles.get(id) || { key: id, title, kind: 'episode', count: 0, seconds: 0, at: 0 };
      prev.count += 1;
      prev.seconds += Math.max(0, row.duration || 0);
      prev.at = Math.max(prev.at || 0, row.updatedAt || 0);
      if (title) prev.title = title;
      titles.set(id, prev);
    }
  }
  const top = [...titles.values()].sort((a, b) => (b.at || 0) - (a.at || 0) || b.count - a.count).slice(0, 10);
  return { movies: movies.size, episodes: episodes.size, shows: shows.size, top };
}

function localDayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function prevLocalDay(dayStart) {
  const d = new Date(dayStart);
  d.setDate(d.getDate() - 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Consecutive local days with a finish. Today may be empty (grace through yesterday)
// so a 10pm finish does not zero the streak at 9am the next morning.
function finishStreak(events, now = Date.now()) {
  const days = new Set();
  for (const e of events || []) {
    if (e && e.at && e.source !== 'play') days.add(localDayStart(e.at));
  }
  if (!days.size) return 0;
  const today = localDayStart(now);
  let cursor = days.has(today) ? today : prevLocalDay(today);
  if (!days.has(cursor)) return 0;
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = prevLocalDay(cursor);
  }
  return n;
}

function summarizeEvents(events, range, now = Date.now()) {
  const r = RANGES.has(range) ? range : 'month';
  const start = rangeStart(r, now);
  const inRange = (events || []).filter((e) => e && e.at >= start);
  const byHour = Array(24).fill(0);
  const movies = new Set();
  const episodes = new Set();
  const shows = new Set();
  const titles = new Map();
  let seconds = 0;
  let weekday = 0;
  let weekend = 0;
  for (const e of inRange) {
    const played = Math.max(0, Number(e.duration) || 0);
    const isPlay = e.source === 'play';
    const isFinish = !isPlay;
    // Hours: play-clock seconds, plus old finish rows that stored full runtime.
    // New finish rows (source:'finish') do not add runtime — that would double-count.
    if (isPlay || !e.source) seconds += played;
    if (isFinish) {
      const hour = new Date(e.at).getHours();
      if (hour >= 0 && hour < 24) byHour[hour] += 1;
      const day = new Date(e.at).getDay();
      if (day === 0 || day === 6) weekend += 1;
      else weekday += 1;
      if (e.kind === 'movie') movies.add(e.key);
      else if (e.kind === 'episode') {
        episodes.add(e.key);
        if (e.showKey) shows.add(e.showKey);
      }
    }
    const id = e.kind === 'episode' && e.showKey ? e.showKey : e.key;
    const t = titles.get(id) || {
      key: id, title: e.title || id, kind: e.kind, count: 0, seconds: 0, poster: e.poster || '',
    };
    if (isFinish) t.count += 1;
    if (isPlay || !e.source) t.seconds += played;
    if (e.title) t.title = e.title;
    if (e.poster) t.poster = e.poster;
    titles.set(id, t);
  }
  let peakHour = null;
  let peakN = 0;
  byHour.forEach((n, h) => { if (n > peakN) { peakN = n; peakHour = h; } });
  if (peakN === 0) peakHour = null;
  const top = [...titles.values()].filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || b.seconds - a.seconds).slice(0, 10);
  const recent = [...inRange]
    .filter((e) => e && e.source !== 'play')
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 10)
    .map((e) => ({
      at: e.at,
      key: e.key,
      kind: e.kind,
      title: e.title || e.key,
      poster: e.poster || '',
    }));
  return {
    range: r,
    hours: Math.round((seconds / 3600) * 10) / 10,
    movies: movies.size,
    episodes: episodes.size,
    shows: shows.size,
    peakHour,
    byHour,
    weekday,
    weekend,
    streak: finishStreak(events, now),
    recent,
    top,
    eventCount: inRange.filter((e) => e && e.source !== 'play').length,
    ledgerEmpty: (events || []).length === 0,
  };
}

function summarize(store, userId, range, now = Date.now()) {
  const doc = store.read('watchStats', { users: {} });
  const events = eventsForUser(doc, userId);
  const stats = summarizeEvents(events, range, now);
  if (stats.range === 'all') {
    const legacy = countWatched(store.read('watch', {}), userId);
    stats.movies = Math.max(stats.movies, legacy.movies);
    stats.episodes = Math.max(stats.episodes, legacy.episodes);
    stats.shows = Math.max(stats.shows, legacy.shows);
    if (!stats.top.length && legacy.top.length) stats.top = legacy.top;
  }
  return stats;
}

module.exports = {
  classify,
  recordFinish,
  recordPlayTime,
  summarize,
  summarizeEvents,
  finishStreak,
  rangeStart,
  countWatched,
  DEDUPE_MS,
  PLAY_MERGE_MS,
  MAX_EVENTS,
};
