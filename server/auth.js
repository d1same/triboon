'use strict';
// Auth: scrypt password hashing (stdlib; Argon2id would need a dependency — documented
// deviation), HMAC-signed stateless tokens, single-use expiring invites, profiles, and
// Quick Connect codes (6 digits, 60s TTL, approve-from-phone).
// Stream tokens: players like VLC can't send headers, so /api/stream accepts a signed,
// scoped, expiring token as a query parameter (the Plex pattern).

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;   // session: 30 days
const STREAM_TTL_MS = 6 * 3600 * 1000;        // stream link: 6 hours (covers any movie + pauses)
const INVITE_TTL_MS = 48 * 3600 * 1000;
const QC_TTL_MS = 60 * 1000;

// Per-key attempt throttle for brute-forceable endpoints (login, profile PIN, invites, QC).
// Windowed counter + lockout — small, in-memory, self-cleaning. The map is bounded so a bot
// flooding unique keys can't leak memory (clearing it only ever *loosens* limits briefly).
class RateLimiter {
  constructor() { this.hits = new Map(); } // key -> { n, resetAt, lockedUntil }
  check(key, { max = 5, windowMs = 60000, lockMs = 60000 } = {}) {
    const now = Date.now();
    if (this.hits.size > 50000) this.hits.clear();
    let e = this.hits.get(key);
    if (e && e.lockedUntil > now) return { ok: false, retryMs: e.lockedUntil - now };
    if (!e || now > e.resetAt) { e = { n: 0, resetAt: now + windowMs, lockedUntil: 0 }; this.hits.set(key, e); }
    e.n++;
    if (e.n > max) { e.lockedUntil = now + lockMs; return { ok: false, retryMs: lockMs }; }
    return { ok: true };
  }
  clear(key) { this.hits.delete(key); }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const got = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

class Auth {
  constructor(store, secret) {
    this.store = store;
    // Server secret: env first; else generated once and persisted (chmod-equivalent N/A on win).
    if (secret) this.secret = secret;
    else {
      const sec = store.read('secret', {});
      if (!sec.value) { sec.value = crypto.randomBytes(32).toString('hex'); store.write('secret', sec); store.flush(); }
      this.secret = sec.value;
    }
    this.quickConnect = new Map(); // code -> { createdAt, deviceName, token? }
  }

  _users() { return this.store.read('users', { list: [] }); }
  _saveUsers(u) { this.store.write('users', u); }

  hasUsers() { return this._users().list.length > 0; }

  createUser({ name, password, role = 'user', policy = {} }) {
    const users = this._users();
    if (users.list.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('user already exists');
    }
    const { salt, hash } = hashPassword(password);
    const user = {
      id: crypto.randomBytes(6).toString('hex'), name, role, salt, hash,
      policy: { maxResolutionRank: 4, allowTranscode: true, ...policy },
      profiles: [{ id: crypto.randomBytes(4).toString('hex'), name, kid: false }],
      createdAt: new Date().toISOString(),
    };
    users.list.push(user);
    this._saveUsers(users);
    return this.publicUser(user);
  }

  publicUser(u) {
    return { id: u.id, name: u.name, role: u.role, policy: u.policy,
      profiles: (u.profiles || []).map((p) => this.publicProfile(p)) };
  }

  // Maturity levels: 0 Kids · 1 Teen · 2 Family · 3 Adult. The catalog is filtered to the
  // profile's level (kids never see mature/adult titles). Optional 4-digit PIN = parental lock.
  addProfile(uid, { name, level = 3, pin }) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    if (!u) throw new Error('unknown user');
    if (!name || !String(name).trim()) throw new Error('profile name required');
    if ((u.profiles || []).length >= 8) throw new Error('profile limit reached');
    const lvl = Math.max(0, Math.min(3, parseInt(level, 10) || 0));
    const profile = {
      id: crypto.randomBytes(4).toString('hex'), name: String(name).trim().slice(0, 24),
      level: lvl, kid: lvl === 0,
    };
    if (pin && /^\d{4}$/.test(String(pin))) profile.pinHash = hashPassword(String(pin));
    u.profiles = u.profiles || [];
    u.profiles.push(profile);
    this._saveUsers(users);
    return this.publicProfile(profile);
  }

  publicProfile(p) {
    const level = p.level ?? (p.kid ? 0 : 3); // back-fill older profiles created before levels
    return { id: p.id, name: p.name, level, kid: level === 0, locked: !!p.pinHash };
  }

  // Set, change, or remove a profile's PIN. The ACCOUNT PASSWORD is required so a kid using
  // the session can't simply lift the parental lock.
  setProfilePin(uid, profileId, accountPassword, pin) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    if (!u || !verifyPassword(String(accountPassword || ''), u.salt, u.hash)) throw new Error('account password incorrect');
    const p = (u.profiles || []).find((x) => x.id === profileId);
    if (!p) throw new Error('unknown profile');
    if (pin === null || pin === '') delete p.pinHash;
    else if (/^\d{4}$/.test(String(pin))) p.pinHash = hashPassword(String(pin));
    else throw new Error('PIN must be 4 digits');
    this._saveUsers(users);
    return this.publicProfile(p);
  }

  verifyProfilePin(uid, profileId, pin) {
    const u = this.getUser(uid);
    const p = u && (u.profiles || []).find((x) => x.id === profileId);
    if (!p) throw new Error('unknown profile');
    if (!p.pinHash) return true; // no lock
    return verifyPassword(String(pin || ''), p.pinHash.salt, p.pinHash.hash);
  }

  // Rename / change level — ACCOUNT PASSWORD required: a kid using the session must not be
  // able to lift their own maturity level (same trust model as setProfilePin).
  editProfile(uid, profileId, accountPassword, { name, level } = {}) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    if (!u || !verifyPassword(String(accountPassword || ''), u.salt, u.hash)) throw new Error('account password incorrect');
    const p = (u.profiles || []).find((x) => x.id === profileId);
    if (!p) throw new Error('unknown profile');
    if (name !== undefined && String(name).trim()) p.name = String(name).trim().slice(0, 20);
    if (level !== undefined && [0, 1, 2, 3].includes(+level)) p.level = +level;
    this._saveUsers(users);
    return this.publicProfile(p);
  }

  deleteProfile(uid, profileId, accountPassword) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    if (!u || !verifyPassword(String(accountPassword || ''), u.salt, u.hash)) throw new Error('account password incorrect');
    const i = (u.profiles || []).findIndex((x) => x.id === profileId);
    if (i < 0) throw new Error('unknown profile');
    u.profiles.splice(i, 1);
    this._saveUsers(users);
    return { ok: true };
  }

  // Admin resets a user's password (forgot-password path — no old password needed; the
  // route gating this is admin-only). Never allowed on admin accounts: an admin's password
  // changes only via their own changePassword (knows-the-current-one proof).
  adminSetPassword(targetUid, newPassword) {
    const users = this._users();
    const u = users.list.find((x) => x.id === targetUid);
    if (!u) throw new Error('user not found');
    if (u.role === 'admin') throw new Error('admin passwords can only be changed by the admin themselves');
    if (String(newPassword || '').length < 4) throw new Error('new password too short');
    const { salt, hash } = hashPassword(String(newPassword));
    u.salt = salt; u.hash = hash;
    this._saveUsers(users);
    return true;
  }

  // Admin removes a user. Admin accounts are not deletable (there is exactly one owner).
  deleteUser(targetUid) {
    const users = this._users();
    const i = users.list.findIndex((x) => x.id === targetUid);
    if (i < 0) throw new Error('user not found');
    if (users.list[i].role === 'admin') throw new Error('the admin account cannot be deleted');
    const removed = users.list.splice(i, 1)[0];
    this._saveUsers(users);
    return { ok: true, name: removed.name };
  }

  changePassword(uid, oldPassword, newPassword) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    if (!u || !verifyPassword(String(oldPassword), u.salt, u.hash)) throw new Error('current password incorrect');
    if (String(newPassword).length < 4) throw new Error('new password too short');
    const { salt, hash } = hashPassword(String(newPassword));
    u.salt = salt; u.hash = hash;
    this._saveUsers(users);
    return true;
  }

  login(name, password) {
    const u = this._users().list.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!u || !verifyPassword(String(password), u.salt, u.hash)) throw new Error('invalid credentials');
    return { token: this.signToken({ uid: u.id, role: u.role, scope: 'session' }, TOKEN_TTL_MS), user: this.publicUser(u) };
  }

  getUser(uid) {
    const u = this._users().list.find((x) => x.id === uid);
    return u || null;
  }

  // ---- tokens: base64url(payload).hmac ----
  signToken(claims, ttlMs) {
    const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + ttlMs })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyToken(token, scope = 'session') {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const want = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(sig || '', 'utf8'), b = Buffer.from(want, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    // Reject missing/non-numeric exp too: a token with no expiry must never validate.
    if (typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
    if (scope && claims.scope !== scope) return null;
    return claims;
  }

  // Stream tokens are BOUND to one resource (mount id / local:<lib>:<idx> / iptv:<idx>):
  // a leaked VLC URL streams that one thing, not everything the account can reach.
  streamToken(uid, sub) { return this.signToken({ uid, scope: 'stream', sub: sub || null }, STREAM_TTL_MS); }

  // ---- invites ----
  createInvite(createdBy, { policy = {} } = {}) {
    const token = crypto.randomBytes(12).toString('base64url');
    this.store.update('invites', {}, (all) => {
      all[token] = { createdBy, policy, expiresAt: Date.now() + INVITE_TTL_MS, usedBy: null };
      return all;
    });
    return { token, expiresAt: Date.now() + INVITE_TTL_MS };
  }

  listInvites() {
    const all = this.store.read('invites', {});
    return Object.entries(all).map(([token, v]) => ({ token, ...v }));
  }

  acceptInvite(token, { name, password }) {
    // Claim the invite ATOMICALLY first (store.update runs synchronously — no interleaving),
    // so two concurrent accepts can't both consume one single-use invite. Roll back if the
    // account can't be created (e.g. name taken).
    let policy;
    this.store.update('invites', {}, (a) => {
      const inv = a[token];
      if (!inv) throw new Error('invalid invite');
      if (inv.usedBy) throw new Error('invite already used');
      if (inv.expiresAt < Date.now()) throw new Error('invite expired');
      inv.usedBy = 'pending'; policy = inv.policy;
      return a;
    });
    let user;
    try {
      user = this.createUser({ name, password, role: 'user', policy });
    } catch (e) {
      this.store.update('invites', {}, (a) => { if (a[token]) a[token].usedBy = null; return a; });
      throw e;
    }
    this.store.update('invites', {}, (a) => { a[token].usedBy = user.id; return a; });
    return this.login(name, password);
  }

  // ---- Quick Connect (TV enters a code, phone approves) ----
  qcCreate(deviceName = 'TV') {
    let code;
    do { code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (this.quickConnect.has(code));
    this.quickConnect.set(code, { createdAt: Date.now(), deviceName, token: null });
    return { code, ttlMs: QC_TTL_MS };
  }
  _qcGet(code) {
    const e = this.quickConnect.get(code);
    if (!e) return null;
    if (Date.now() - e.createdAt > QC_TTL_MS) { this.quickConnect.delete(code); return null; }
    return e;
  }
  sweepQuickConnect() { // expired codes are otherwise only purged on access
    const now = Date.now();
    for (const [code, e] of this.quickConnect) if (now - e.createdAt > QC_TTL_MS) this.quickConnect.delete(code);
  }
  qcApprove(code, approverUid) {
    const e = this._qcGet(code);
    if (!e) throw new Error('code expired or unknown');
    const u = this.getUser(approverUid);
    if (!u) throw new Error('unknown user');
    e.token = this.signToken({ uid: u.id, role: u.role, scope: 'session' }, TOKEN_TTL_MS);
    return { ok: true, deviceName: e.deviceName };
  }
  qcPoll(code) {
    const e = this._qcGet(code);
    if (!e) return { status: 'expired' };
    if (!e.token) return { status: 'pending' };
    const token = e.token;
    this.quickConnect.delete(code);
    return { status: 'approved', token };
  }
}

// ---- settings encrypted at rest (AES-256-GCM, key derived from the server secret) ----
class SecureSettings {
  constructor(store, secret) {
    this.store = store;
    this.key = crypto.createHash('sha256').update('triboon-settings:' + secret).digest();
  }
  _encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') };
  }
  _decrypt(blob) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8'));
  }
  get() {
    const blob = this.store.read('settings', null);
    if (!blob || !blob.iv) return { providers: [], indexers: [], tmdbKey: null };
    try { return this._decrypt(blob); } catch { return { providers: [], indexers: [], tmdbKey: null }; }
  }
  set(settings) {
    this.store.write('settings', this._encrypt(settings));
    this.store.flush();
    return settings;
  }
  update(mutator) { return this.set(mutator(this.get())); }
}

module.exports = { Auth, SecureSettings, RateLimiter, hashPassword, verifyPassword };
