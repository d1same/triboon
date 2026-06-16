'use strict';
// Trakt sync. Each USER links their own Trakt account with the device-code flow (enter a
// short code at trakt.tv/activate — the TV-friendly way), then the server:
//   - scrobbles playback (/scrobble/stop with progress) as they watch,
//   - pushes watchlist adds/removes,
//   - imports their Trakt watchlist on demand.
// The admin provides the app's client id/secret (a free "API app" on trakt.tv) in Settings.
// Tokens are per-user, kept in the encrypted-at-rest store, refreshed automatically.

const http = require('http');
const https = require('https');

const BASE = () => process.env.TRAKT_BASE || 'https://api.trakt.tv';

// timeout = socket idle; the deadline is a HARD total budget — a trickling response never
// idles, and several callers (link/exchange) run inside user-facing request handlers.
function request(path, { method = 'POST', body, token, clientId, deadlineMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE() + path);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(url, {
      method,
      agent: false, // one-shot calls — don't hold keep-alive sockets to api.trakt.tv
      headers: {
        'content-type': 'application/json',
        'trakt-api-version': '2',
        // Cloudflare fronts api.trakt.tv and 403s UA-less requests with an HTML block page —
        // which surfaced as "Trakt rejected the client id" while the id was perfectly fine.
        'user-agent': 'Triboon/0.5 (+https://github.com/d1same/triboon)',
        ...(clientId ? { 'trakt-api-key': clientId } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(deadline);
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error(`trakt deadline after ${deadlineMs}ms`)), deadlineMs);
    req.on('timeout', () => req.destroy(new Error('trakt timeout')));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.end(payload);
  });
}

class Trakt {
  constructor(store, getSettings) {
    this.store = store;
    this.getSettings = getSettings;
    this.pendingCodes = new Map(); // uid -> { deviceCode, interval, expiresAt }
  }

  _creds() {
    const s = this.getSettings();
    return { id: s.traktClientId || null, secret: s.traktClientSecret || null };
  }
  configured() { return !!this._creds().id; }

  _tokens() { return this.store.read('trakt', {}); }
  _outbox() { return this.store.read('traktOutbox', {}); }
  _saveToken(uid, tok) {
    this.store.update('trakt', {}, (all) => { all[uid] = tok; return all; });
  }
  status(uid) {
    const t = this._tokens()[uid];
    return { configured: this.configured(), linked: !!t, user: t ? t.username || null : null };
  }
  unlink(uid) { this.store.update('trakt', {}, (all) => { delete all[uid]; return all; }); }

  // ---- device-code linking ----
  async linkStart(uid) {
    const { id } = this._creds();
    if (!id) throw new Error('Trakt is not configured by the admin');
    const r = await request('/oauth/device/code', { body: { client_id: id } });
    if (r.status !== 200 || !r.json) {
      // Surface WHY — "doesn't work" without the status was undebuggable for admins.
      const why = r.status === 403 || r.status === 404
        ? 'Trakt rejected the client id — re-check Settings → Catalog → Trakt (use the app\'s Client ID, not its name)'
        : `Trakt answered HTTP ${r.status}${r.json && r.json.error_description ? ` — ${r.json.error_description}` : ''}`;
      throw new Error(why);
    }
    this.pendingCodes.set(uid, {
      deviceCode: r.json.device_code,
      interval: (r.json.interval || 5) * 1000,
      expiresAt: Date.now() + (r.json.expires_in || 600) * 1000,
    });
    return { userCode: r.json.user_code, url: r.json.verification_url || 'https://trakt.tv/activate', intervalMs: (r.json.interval || 5) * 1000 };
  }

  async linkPoll(uid) {
    const pending = this.pendingCodes.get(uid);
    if (!pending) return { state: 'none' };
    if (Date.now() > pending.expiresAt) { this.pendingCodes.delete(uid); return { state: 'expired' }; }
    const { id, secret } = this._creds();
    const r = await request('/oauth/device/token', { body: { code: pending.deviceCode, client_id: id, client_secret: secret } });
    if (r.status === 200 && r.json && r.json.access_token) {
      this.pendingCodes.delete(uid);
      const tok = {
        access: r.json.access_token, refresh: r.json.refresh_token,
        expiresAt: Date.now() + (r.json.expires_in || 7776000) * 1000,
      };
      // Friendly display name (best effort).
      try {
        const me = await request('/users/settings', { method: 'GET', token: tok.access, clientId: id });
        if (me.json && me.json.user) tok.username = me.json.user.username;
      } catch {}
      this._saveToken(uid, tok);
      return { state: 'linked', user: tok.username || null };
    }
    if (r.status === 400) return { state: 'pending' };
    this.pendingCodes.delete(uid);
    return { state: r.status === 409 ? 'already-used' : 'denied' };
  }

  // PIN path: Trakt apps with the urn:…:oob redirect show the user an authorization code
  // after approving in the browser — accept it pasted into Triboon and exchange for tokens.
  async exchangeCode(uid, code) {
    const { id, secret } = this._creds();
    if (!id) throw new Error('Trakt is not configured by the admin');
    const r = await request('/oauth/token', {
      body: { code: String(code || '').trim(), client_id: id, client_secret: secret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'authorization_code' },
    });
    if (r.status !== 200 || !r.json || !r.json.access_token) {
      throw new Error(`Trakt rejected the code (HTTP ${r.status}) — paste the PIN exactly as shown after authorizing`);
    }
    this.pendingCodes.delete(uid);
    const tok = {
      access: r.json.access_token, refresh: r.json.refresh_token,
      expiresAt: Date.now() + (r.json.expires_in || 7776000) * 1000,
    };
    try {
      const me = await request('/users/settings', { method: 'GET', token: tok.access, clientId: id });
      if (me.json && me.json.user) tok.username = me.json.user.username;
    } catch {}
    this._saveToken(uid, tok);
    return { state: 'linked', user: tok.username || null };
  }

  async _tokenFor(uid) {
    const t = this._tokens()[uid];
    if (!t) return null;
    if (Date.now() < t.expiresAt - 600000) return t.access;
    const { id, secret } = this._creds();
    const r = await request('/oauth/token', {
      body: { refresh_token: t.refresh, client_id: id, client_secret: secret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token' },
    });
    if (r.status === 200 && r.json && r.json.access_token) {
      const tok = { ...t, access: r.json.access_token, refresh: r.json.refresh_token,
        expiresAt: Date.now() + (r.json.expires_in || 7776000) * 1000 };
      this._saveToken(uid, tok);
      return tok.access;
    }
    return null; // refresh failed — user must relink
  }

  async api(uid, path, method = 'GET', body) {
    const token = await this._tokenFor(uid);
    if (!token) return null;
    return request(path, { method, body, token, clientId: this._creds().id });
  }

  // ---- the payload Trakt wants for one of our watch keys ----
  // tmdb:movie:603 → { movie:{ids:{tmdb:603}} }
  // tmdb:tv:1399:s1e2 → { show:{ids:{tmdb:1399}}, episode:{season:1, number:2} }
  static itemFor(key) {
    let m = /^tmdb:movie:(\d+)$/.exec(key || '');
    if (m) return { movie: { ids: { tmdb: +m[1] } } };
    m = /^tmdb:tv:(\d+):s(\d+)e(\d+)$/.exec(key || '');
    if (m) return { show: { ids: { tmdb: +m[1] } }, episode: { season: +m[2], number: +m[3] } };
    m = /^tmdb:tv:(\d+)$/.exec(key || '');
    if (m) return { show: { ids: { tmdb: +m[1] } } };
    return null;
  }

  _opKey(op) { return `${op.kind}:${op.key}`; }

  _requestForOp(op) {
    const item = Trakt.itemFor(op.key);
    if (!item) return null;
    if (op.kind === 'scrobble') {
      if (item.show && !item.episode) return null; // bare shows aren't scrobblable
      return { path: '/scrobble/stop', body: { ...item, progress: op.progress } };
    }
    if (op.kind === 'watchlist') {
      const body = item.movie ? { movies: [item.movie] } : { shows: [item.show] };
      return { path: op.on ? '/sync/watchlist' : '/sync/watchlist/remove', body };
    }
    if (op.kind === 'history') {
      const body = item.movie ? { movies: [item.movie] }
        : item.episode ? { shows: [{ ...item.show, seasons: [{ number: item.episode.season, episodes: [{ number: item.episode.number }] }] }] }
        : { shows: [item.show] };
      return { path: op.on ? '/sync/history' : '/sync/history/remove', body };
    }
    return null;
  }

  async _sendOp(uid, op) {
    const req = this._requestForOp(op);
    if (!req) return { ok: true, skipped: true };
    const r = await this.api(uid, req.path, 'POST', req.body);
    if (!r) return { ok: false, status: 0, error: 'not linked' };
    return { ok: (r.status >= 200 && r.status < 300) || r.status === 409, status: r.status };
  }

  _queueOp(uid, op, reason) {
    const now = Date.now();
    this.store.update('traktOutbox', {}, (all) => {
      const list = Array.isArray(all[uid]) ? all[uid] : [];
      const key = this._opKey(op);
      const kept = list.filter((x) => this._opKey(x) !== key);
      kept.push({
        ...op,
        id: `${now}-${Math.random().toString(36).slice(2)}`,
        queuedAt: now,
        attempts: 0,
        lastError: String(reason || 'failed'),
      });
      all[uid] = kept.slice(-500);
      return all;
    });
  }

  _fire(uid, op, label) {
    this._sendOp(uid, op)
      .then((r) => { if (!r.ok) this._queueOp(uid, op, r.status || r.error); })
      .catch((e) => {
        this._queueOp(uid, op, e.message);
        console.error(`[trakt ${label}]`, e.message);
      });
  }

  async flushOutbox(uid, max = 50) {
    const now = Date.now();
    const all = this._outbox();
    const current = Array.isArray(all[uid]) ? all[uid] : [];
    const due = current.filter((op) => !op.nextTryAt || op.nextTryAt <= now).slice(0, max);
    if (!due.length) return { sent: 0, failed: 0, pending: current.length };
    const sent = new Set();
    const failed = new Map();
    for (const op of due) {
      try {
        const r = await this._sendOp(uid, op);
        if (r.ok) sent.add(op.id);
        else {
          const attempts = (op.attempts || 0) + 1;
          failed.set(op.id, {
            ...op,
            attempts,
            lastError: String(r.status || r.error || 'failed'),
            nextTryAt: now + Math.min(6 * 3600000, 300000 * (2 ** Math.min(attempts, 5))),
          });
        }
      } catch (e) {
        const attempts = (op.attempts || 0) + 1;
        failed.set(op.id, {
          ...op,
          attempts,
          lastError: e.message,
          nextTryAt: now + Math.min(6 * 3600000, 300000 * (2 ** Math.min(attempts, 5))),
        });
      }
    }
    let pending = 0;
    this.store.update('traktOutbox', {}, (nextAll) => {
      const list = Array.isArray(nextAll[uid]) ? nextAll[uid] : [];
      nextAll[uid] = list.map((op) => failed.get(op.id) || op).filter((op) => !sent.has(op.id)).slice(-500);
      pending = nextAll[uid].length;
      return nextAll;
    });
    return { sent: sent.size, failed: failed.size, pending };
  }

  // Fire-and-forget playback scrobble (errors only logged — never blocks the player).
  scrobble(uid, key, progress, finished) {
    let pct = Number.isFinite(+progress) ? +progress : 0;
    if (finished) pct = 100;
    else if (pct < 1) return;
    else pct = Math.min(79, pct); // /scrobble/stop marks watched above 80%.
    this._fire(uid, { kind: 'scrobble', key, progress: Math.max(1, Math.min(100, Math.round(pct))) }, 'scrobble');
  }

  watchlist(uid, key, on) {
    if (!Trakt.itemFor(key)) return;
    this._fire(uid, { kind: 'watchlist', key, on: !!on }, 'watchlist');
  }

  // Explicit ✓/unwatch from the UI → Trakt history (scrobble only covers real playback).
  // A bare show key marks/unmarks the WHOLE show — matches the bulk mark-series action.
  history(uid, key, on) {
    if (!Trakt.itemFor(key)) return;
    this._fire(uid, { kind: 'history', key, on: !!on }, 'history');
  }

  // Everything the user has WATCHED on Trakt → our watch keys. Movies + per-episode shows.
  async pullWatched(uid) {
    const keys = [];
    const mv = await this.api(uid, '/sync/watched/movies', 'GET');
    for (const e of (mv && mv.status === 200 && Array.isArray(mv.json) ? mv.json : [])) {
      const id = e.movie && e.movie.ids && e.movie.ids.tmdb;
      if (id) keys.push({ key: `tmdb:movie:${id}`, title: e.movie.title || '', year: e.movie.year || null, type: 'movie', tmdbId: id });
    }
    const sh = await this.api(uid, '/sync/watched/shows', 'GET');
    for (const e of (sh && sh.status === 200 && Array.isArray(sh.json) ? sh.json : [])) {
      const id = e.show && e.show.ids && e.show.ids.tmdb;
      if (!id) continue;
      for (const s of e.seasons || []) {
        for (const ep of s.episodes || []) {
          keys.push({ key: `tmdb:tv:${id}:s${s.number}e${ep.number}`, title: e.show.title || '', year: e.show.year || null, type: 'episode', tmdbId: id });
        }
      }
    }
    return keys.slice(0, 20000); // a heavy account stays bounded
  }

  // In-progress playback (Trakt stores a PERCENT, not seconds) → continue-watching imports.
  async pullPlayback(uid) {
    const r = await this.api(uid, '/sync/playback', 'GET');
    if (!r || r.status !== 200 || !Array.isArray(r.json)) return [];
    const out = [];
    for (const e of r.json.slice(0, 100)) {
      const pct = +e.progress || 0;
      if (pct < 2 || pct > 96) continue; // ends are noise — finished or barely started
      if (e.movie && e.movie.ids && e.movie.ids.tmdb) {
        out.push({ key: `tmdb:movie:${e.movie.ids.tmdb}`, pct, title: e.movie.title || '', year: e.movie.year || null, type: 'movie', tmdbId: e.movie.ids.tmdb, pausedAt: Date.parse(e.paused_at || '') || Date.now() });
      } else if (e.episode && e.show && e.show.ids && e.show.ids.tmdb) {
        out.push({ key: `tmdb:tv:${e.show.ids.tmdb}:s${e.episode.season}e${e.episode.number}`, pct,
          title: `${e.show.title || ''} — S${String(e.episode.season).padStart(2, '0')}E${String(e.episode.number).padStart(2, '0')}`,
          year: e.show.year || null, type: 'episode', tmdbId: e.show.ids.tmdb, pausedAt: Date.parse(e.paused_at || '') || Date.now() });
      }
    }
    return out;
  }

  // Pull the user's Trakt watchlist → [{key, title, type, year}] for merging into ours.
  async pullWatchlist(uid) {
    const r = await this.api(uid, '/sync/watchlist', 'GET');
    if (!r || r.status !== 200 || !Array.isArray(r.json)) return [];
    const out = [];
    for (const e of r.json.slice(0, 500)) {
      const media = e.movie || e.show;
      const type = e.movie ? 'movie' : 'tv';
      if (!media || !media.ids || !media.ids.tmdb) continue;
      out.push({ key: `tmdb:${type}:${media.ids.tmdb}`, title: media.title || '', type, year: media.year || null, tmdbId: media.ids.tmdb });
    }
    return out;
  }
}

module.exports = { Trakt, _request: request };
