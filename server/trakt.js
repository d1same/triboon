'use strict';
// Trakt sync. Each USER links their own Trakt account with the device-code flow (enter a
// short code at trakt.tv/activate — the TV-friendly way), then the server:
//   - scrobbles playback (pause/stop with progress) as they watch,
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

  // Fire-and-forget playback scrobble (errors only logged — never blocks the player).
  scrobble(uid, key, progress, finished) {
    const item = Trakt.itemFor(key);
    if (!item || item.show && !item.episode) return; // bare shows aren't scrobblable
    const action = finished ? 'stop' : 'pause';
    this.api(uid, `/scrobble/${action}`, 'POST', { ...item, progress: Math.max(0, Math.min(100, Math.round(progress))) })
      .catch((e) => console.error('[trakt scrobble]', e.message));
  }

  watchlist(uid, key, on) {
    const item = Trakt.itemFor(key);
    if (!item) return;
    const body = item.movie ? { movies: [item.movie] } : { shows: [item.show] };
    this.api(uid, on ? '/sync/watchlist' : '/sync/watchlist/remove', 'POST', body)
      .catch((e) => console.error('[trakt watchlist]', e.message));
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
