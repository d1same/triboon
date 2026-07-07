'use strict';
// Auth: scrypt password hashing (stdlib; Argon2id would need a dependency — documented
// deviation), HMAC-signed stateless tokens, single-use expiring invites, profiles, and
// Quick Connect codes (6 digits, 60s TTL, approve-from-phone).
// Stream tokens: players like VLC can't send headers, so /api/stream accepts a signed,
// scoped, expiring token as a query parameter (the Plex pattern).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Synchronous short sleep for the boot-time secret retry (only ever runs when secret.json is
// momentarily unreadable right after a Windows install; never on a normal boot).
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin fallback */ } }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;   // session: 30 days
const STREAM_TTL_MS = 6 * 3600 * 1000;        // stream link: 6 hours (covers any movie + pauses)
const STABLE_STREAM_BUCKET_MS = 60 * 60 * 1000; // cache-stable URLs, still max 6h validity
const INVITE_TTL_MS = 48 * 3600 * 1000;
const QC_TTL_MS = 60 * 1000;
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOTP_PERIOD_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_ISSUER = 'Triboon';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function deriveKey(secret, label) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(String(secret || ''), 'utf8'),
    Buffer.from('triboon', 'utf8'),
    Buffer.from(String(label || ''), 'utf8'),
    32
  ));
}

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
// Built-in profile avatars ship as web/avatars/av01.svg..av20.svg; the profile stores only the
// id. 'custom' (an uploaded picture) is set exclusively by the upload route, never accepted
// from a bare profile edit — so a profile can't claim a custom image that was never uploaded.
function validAvatarId(a) { return /^av(0[1-9]|1\d|20)$/.test(String(a || '')); }
// Every profile gets a face: profiles created before avatars existed (or after a "remove")
// derive a STABLE builtin from their id hash — no migration write, no bare letter tiles, and
// the same face on every device/session. An explicit pick or upload always overrides.
function derivedAvatarId(id) {
  const n = parseInt(String(id || '0').slice(0, 8), 16) || 0;
  return `av${String((n % 20) + 1).padStart(2, '0')}`;
}
function verifyPassword(password, salt, hash) {
  const got = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret, at = Date.now(), offset = 0) {
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / TOTP_PERIOD_SEC) + offset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.max(0, counter)));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function verifyTotpCode(secret, code, at = Date.now()) {
  const got = String(code || '').trim();
  if (!/^\d{6}$/.test(got)) return false;
  for (const offset of [-1, 0, 1]) {
    const want = totpCode(secret, at, offset);
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function generateRecoveryCode() {
  const raw = base32Encode(crypto.randomBytes(6)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

class Auth {
  constructor(store, secret) {
    this.store = store;
    // Server secret: env first; else generated ONCE and persisted. This secret encrypts settings and
    // signs tokens — regenerating it orphans every encrypted setting (the "settings wiped on update"
    // bug). We ONLY generate when secret.json genuinely does not exist. If it EXISTS but can't be read
    // yet (an AV/permission lock right after a Windows reinstall), we RETRY PATIENTLY here — the server
    // can't function without the real secret, and the lock almost always clears within seconds. We must
    // NEVER crash while waiting (that surfaces as Error 1067 "the service won't start"), and never
    // regenerate unless the file is truly unrecoverable — and even then we PRESERVE the old one.
    if (secret) this.secret = secret;
    else {
      const secFile = path.join(store.dir, 'secret.json');
      const sec = store.read('secret', {});
      if (sec && sec.value) {
        this.secret = sec.value;                       // normal path
      } else if (fs.existsSync(secFile)) {
        // Exists but unreadable. Retry directly (bypassing the cached fallback) for a while — a
        // Defender scan or an installer ACL change clears well within this window.
        const tries = Math.max(1, parseInt(process.env.TRIBOON_SECRET_READ_RETRIES, 10) || 40);
        const delay = Math.max(20, parseInt(process.env.TRIBOON_SECRET_READ_DELAY_MS, 10) || 500);
        let value = null;
        for (let i = 0; i < tries && !value; i++) {
          sleepMs(delay);
          try { const v = JSON.parse(fs.readFileSync(secFile, 'utf8')); if (v && v.value) value = v.value; } catch {}
        }
        if (value) {
          this.secret = value;
          try { store.write('secret', { value }); } catch {}   // recovered — prime the cache, no rewrite of content
          console.error('[triboon] secret.json was temporarily unreadable at boot; recovered it on retry — no data touched.');
        } else {
          // Truly unrecoverable (corrupt, or a permission problem that outlived the retries). Do the
          // LEAST-bad thing that still lets the server RUN (never crash-loop): preserve the old secret
          // for manual recovery, then mint a new one. Encrypted settings may need re-entering, but the
          // server starts and the original secret is kept.
          try { fs.renameSync(secFile, secFile + '.unreadable-' + Date.now()); } catch {}
          const fresh = crypto.randomBytes(32).toString('hex');
          try { store.write('secret', { value: fresh }); store.flush(); } catch {}
          this.secret = fresh;
          console.error('[triboon] WARNING: secret.json existed but was unreadable after retries. Generated a '
            + 'new secret so the server can start; saved settings may need re-entering. The old secret was kept '
            + 'alongside it (secret.json.unreadable-*) for recovery. File: ' + secFile);
        }
      } else {
        const value = crypto.randomBytes(32).toString('hex');
        store.write('secret', { value }); store.flush();
        this.secret = value;                           // fresh install
      }
    }
    this.tokenKey = deriveKey(this.secret, 'auth-token-hmac-v1');
    this.totpKey = deriveKey(this.secret, 'admin-totp-aes-gcm-v1');
    this.quickConnect = new Map(); // code -> { createdAt, deviceName, token? }
    this._migrateMaturitySchema();
  }

  // One-time maturity-tier migration (v1 → v2). v1 tiers: 0 Kids(≤PG) · 1 Teen(≤PG-13) ·
  // 2 Family(≤PG-13) · 3 Adult(all). v2 tiers: 0 G · 1 PG · 2 PG-13 · 3 R · 4 No limit. The remap
  // PRESERVES each profile's certification cap so NO profile ever becomes more permissive:
  // Teen→PG-13, Family→PG-13, Adult→No limit; Kids stays 0 (now "G" — a slight tightening on cert,
  // never a loosening). Legacy profiles with no stored level back-fill from the old `kid` flag
  // first (kid → 0, else old-Adult 3). Idempotent + guarded by a stored schema stamp so it runs once.
  _migrateMaturitySchema() {
    let users;
    try { users = this._users(); } catch { return; }
    if ((users.maturitySchema || 0) >= 2) return;
    // NEVER stamp+save an empty users file over real accounts: if users.json EXISTS on disk but we
    // read an empty list, the read failed transiently (lock/corrupt) — skip and let a later boot with
    // a clean read do the migration. Otherwise this wipes the admin ("create admin again after update").
    if ((!users.list || !users.list.length) && fs.existsSync(path.join(this.store.dir, 'users.json'))) return;
    const REMAP = { 0: 0, 1: 2, 2: 2, 3: 4 };
    for (const u of users.list || []) {
      for (const p of (u.profiles || [])) {
        const old = p.level ?? (p.kid ? 0 : 3);   // old-scheme effective level
        const next = REMAP[old] ?? 4;              // unknown/out-of-range → No limit (matches back-fill)
        p.level = next;
        p.kid = next === 0;
      }
    }
    users.maturitySchema = 2;
    this._saveUsers(users);
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
      sessionEpoch: 0,
      policy: { maxResolutionRank: 4, allowTranscode: true, ...policy },
      profiles: [{ id: crypto.randomBytes(4).toString('hex'), name, level: 4, kid: false }],
      createdAt: new Date().toISOString(),
    };
    users.list.push(user);
    this._saveUsers(users);
    return this.publicUser(user);
  }

  publicUser(u) {
    return { id: u.id, name: u.name, role: u.role, policy: u.policy,
      twoFactorEnabled: !!(u.totp && u.totp.enabled),
      profiles: (u.profiles || []).map((p) => this.publicProfile(p)) };
  }

  // Maturity tiers by rating cap: 0 G · 1 PG · 2 PG-13 · 3 R · 4 No limit. The catalog is filtered
  // to the profile's tier (a G/PG profile never sees mature titles). Optional 4-digit PIN = parental lock.
  addProfile(uid, { name, level = 4, pin, avatar }) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    if (!u) throw new Error('unknown user');
    if (!name || !String(name).trim()) throw new Error('profile name required');
    if ((u.profiles || []).length >= 8) throw new Error('profile limit reached');
    const lvl = Math.max(0, Math.min(4, parseInt(level, 10) || 0));
    const profile = {
      id: crypto.randomBytes(4).toString('hex'), name: String(name).trim().slice(0, 24),
      level: lvl, kid: lvl === 0,
    };
    if (validAvatarId(avatar)) profile.avatar = String(avatar);
    if (pin && /^\d{4}$/.test(String(pin))) profile.pinHash = hashPassword(String(pin));
    u.profiles = u.profiles || [];
    u.profiles.push(profile);
    this._saveUsers(users);
    return this.publicProfile(profile);
  }

  // Avatar is cosmetic — unlike name/level it needs NO account password (a kid picking a fox
  // face is fine; the trust model only guards maturity/identity changes). 'custom' is set by
  // the upload route after it has stored a sanitized image; null clears back to the initial.
  setProfileAvatar(uid, profileId, avatar) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    if (!u) throw new Error('unknown user');
    const p = (u.profiles || []).find((x) => x.id === profileId);
    if (!p) throw new Error('unknown profile');
    if (avatar === null || avatar === '') delete p.avatar;
    else if (validAvatarId(avatar) || avatar === 'custom') p.avatar = String(avatar);
    else throw new Error('unknown avatar');
    this._saveUsers(users);
    return this.publicProfile(p);
  }

  publicProfile(p) {
    const level = p.level ?? (p.kid ? 0 : 4); // back-fill any profile still missing a tier (kid → G, else No limit)
    return { id: p.id, name: p.name, level, kid: level === 0, locked: !!p.pinHash,
      avatar: p.avatar || derivedAvatarId(p.id) }; // everyone gets a face (stable id-derived default)
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
    if (level !== undefined && [0, 1, 2, 3, 4].includes(+level)) { p.level = +level; p.kid = +level === 0; }
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
    u.sessionEpoch = (u.sessionEpoch || 0) + 1;
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
    u.sessionEpoch = (u.sessionEpoch || 0) + 1;
    this._saveUsers(users);
    return true;
  }

  sessionForUser(u) {
    return this.signToken({ uid: u.id, role: u.role, scope: 'session', epoch: u.sessionEpoch || 0 }, TOKEN_TTL_MS);
  }

  _encryptTotpSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.totpKey, iv);
    const ct = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') };
  }

  _decryptTotpSecret(blob) {
    if (!blob || !blob.iv || !blob.tag || !blob.data) throw new Error('2FA secret is missing');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.totpKey, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
  }

  _assertAdminWithPassword(u, accountPassword) {
    if (!u || u.role !== 'admin') throw new Error('admin only');
    if (!verifyPassword(String(accountPassword || ''), u.salt, u.hash)) throw new Error('current password incorrect');
  }

  _verifyTotpOrRecovery(u, code) {
    if (!u || !u.totp || !u.totp.enabled) throw new Error('2FA is not enabled');
    const secret = this._decryptTotpSecret(u.totp.secret);
    if (verifyTotpCode(secret, code)) return { ok: true, recoveryUsed: false };
    const normalized = normalizeRecoveryCode(code);
    if (normalized.length >= 8) {
      const recovery = Array.isArray(u.totp.recovery) ? u.totp.recovery : [];
      for (let i = 0; i < recovery.length; i++) {
        const h = recovery[i];
        if (h && verifyPassword(normalized, h.salt, h.hash)) {
          recovery.splice(i, 1);
          u.totp.recovery = recovery;
          return { ok: true, recoveryUsed: true };
        }
      }
    }
    return { ok: false, recoveryUsed: false };
  }

  twoFactorStatus(uid) {
    const u = this.getUser(uid);
    const t = u && u.totp;
    return {
      enabled: !!(t && t.enabled),
      pending: !!(t && t.pending),
      recoveryCodesRemaining: t && Array.isArray(t.recovery) ? t.recovery.length : 0,
    };
  }

  startTotpSetup(uid, accountPassword) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    this._assertAdminWithPassword(u, accountPassword);
    const secret = base32Encode(crypto.randomBytes(20));
    const label = `${TOTP_ISSUER}:${u.name}`;
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&period=${TOTP_PERIOD_SEC}&digits=${TOTP_DIGITS}`;
    u.totp = {
      ...(u.totp || {}),
      pending: this._encryptTotpSecret(secret),
      pendingAt: new Date().toISOString(),
    };
    this._saveUsers(users);
    return { secret, otpauthUrl, issuer: TOTP_ISSUER, account: u.name, period: TOTP_PERIOD_SEC, digits: TOTP_DIGITS };
  }

  enableTotp(uid, accountPassword, code) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    this._assertAdminWithPassword(u, accountPassword);
    if (!u.totp || !u.totp.pending) throw new Error('start 2FA setup first');
    const secret = this._decryptTotpSecret(u.totp.pending);
    if (!verifyTotpCode(secret, code)) throw new Error('invalid 2FA code');
    const recoveryCodes = Array.from({ length: 8 }, () => generateRecoveryCode());
    u.totp = {
      enabled: true,
      secret: this._encryptTotpSecret(secret),
      recovery: recoveryCodes.map((c) => hashPassword(normalizeRecoveryCode(c))),
      enabledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    u.sessionEpoch = (u.sessionEpoch || 0) + 1;
    this._saveUsers(users);
    return { ok: true, user: this.publicUser(u), token: this.sessionForUser(u), recoveryCodes };
  }

  disableTotp(uid, accountPassword, code) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    this._assertAdminWithPassword(u, accountPassword);
    if (u.totp && u.totp.enabled) {
      const verdict = this._verifyTotpOrRecovery(u, code);
      if (!verdict.ok) throw new Error('invalid 2FA code');
    }
    delete u.totp;
    u.sessionEpoch = (u.sessionEpoch || 0) + 1;
    this._saveUsers(users);
    return { ok: true, user: this.publicUser(u), token: this.sessionForUser(u) };
  }

  regenerateTotpRecovery(uid, accountPassword, code) {
    const users = this._users();
    const u = users.list.find((x) => x.id === uid);
    this._assertAdminWithPassword(u, accountPassword);
    const verdict = this._verifyTotpOrRecovery(u, code);
    if (!verdict.ok) throw new Error('invalid 2FA code');
    const recoveryCodes = Array.from({ length: 8 }, () => generateRecoveryCode());
    u.totp.recovery = recoveryCodes.map((c) => hashPassword(normalizeRecoveryCode(c)));
    u.totp.updatedAt = new Date().toISOString();
    this._saveUsers(users);
    return { ok: true, recoveryCodes, recoveryCodesRemaining: u.totp.recovery.length };
  }

  login(name, password) {
    const u = this._users().list.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!u || !verifyPassword(String(password), u.salt, u.hash)) throw new Error('invalid credentials');
    if (u.role === 'admin' && u.totp && u.totp.enabled) {
      return {
        twoFactorRequired: true,
        challenge: this.signToken({ uid: u.id, role: u.role, scope: 'totp', epoch: u.sessionEpoch || 0 }, TOTP_CHALLENGE_TTL_MS),
        user: this.publicUser(u),
      };
    }
    return { token: this.sessionForUser(u), user: this.publicUser(u) };
  }

  completeTotpLogin(challenge, code) {
    const claims = this.verifyToken(challenge, 'totp');
    if (!claims) throw new Error('2FA challenge expired');
    const users = this._users();
    const u = users.list.find((x) => x.id === claims.uid);
    if (!u || !this.claimsValidForUser(claims, u)) throw new Error('2FA challenge expired');
    const verdict = this._verifyTotpOrRecovery(u, code);
    if (!verdict.ok) throw new Error('invalid 2FA code');
    if (verdict.recoveryUsed) this._saveUsers(users);
    return { token: this.sessionForUser(u), user: this.publicUser(u), recoveryUsed: verdict.recoveryUsed };
  }

  getUser(uid) {
    const u = this._users().list.find((x) => x.id === uid);
    return u || null;
  }

  // ---- tokens: base64url(payload).hmac ----
  signToken(claims, ttlMs) {
    const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + ttlMs })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.tokenKey).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyToken(token, scope = 'session') {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const sigBuf = Buffer.from(sig || '', 'utf8');
    const signatures = [crypto.createHmac('sha256', this.tokenKey).update(payload).digest('base64url')];
    // Legacy sessions were signed directly with TRIBOON_SECRET. Keep old browser logins
    // alive through expiry, but never accept legacy raw-secret signatures for stream URLs.
    if (scope === 'session') signatures.push(crypto.createHmac('sha256', this.secret).update(payload).digest('base64url'));
    let ok = false;
    for (const want of signatures) {
      const wantBuf = Buffer.from(want, 'utf8');
      if (sigBuf.length === wantBuf.length && crypto.timingSafeEqual(sigBuf, wantBuf)) { ok = true; break; }
    }
    if (!ok) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    // Reject missing/non-numeric exp too: a token with no expiry must never validate.
    if (typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
    if (scope && claims.scope !== scope) return null;
    return claims;
  }

  claimsValidForUser(claims, user) {
    if (!claims || !user) return false;
    return (claims.epoch || 0) === (user.sessionEpoch || 0);
  }

  // Stream tokens are BOUND to one resource (mount id / local:<lib>:<idx> / iptv:<idx>):
  // a leaked VLC URL streams that one thing, not everything the account can reach.
  streamToken(uid, sub) {
    const u = this.getUser(uid);
    return this.signToken({ uid, scope: 'stream', sub: sub || null, epoch: u ? (u.sessionEpoch || 0) : 0 }, STREAM_TTL_MS);
  }

  // STABLE stream token: same (uid, sub) -> same token for a one-hour cache bucket, with
  // expiry capped at the normal 6h stream-token lifetime. Library art/thumb/file URLs minted
  // per /items request used to differ on every call, so the browser cache never held covers.
  stableStreamToken(uid, sub) {
    const now = Date.now();
    const exp = Math.min(now + STREAM_TTL_MS,
      Math.floor(now / STABLE_STREAM_BUCKET_MS) * STABLE_STREAM_BUCKET_MS + STREAM_TTL_MS);
    const u = this.getUser(uid);
    const payload = Buffer.from(JSON.stringify({ uid, scope: 'stream', sub: sub || null, exp })).toString('base64url');
    const withEpoch = JSON.stringify({ uid, scope: 'stream', sub: sub || null, epoch: u ? (u.sessionEpoch || 0) : 0, exp });
    const epochPayload = Buffer.from(withEpoch).toString('base64url');
    const sig = crypto.createHmac('sha256', this.tokenKey).update(epochPayload).digest('base64url');
    if (payload === epochPayload) return `${payload}.${sig}`;
    return `${epochPayload}.${sig}`;
  }

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
    e.token = this.signToken({ uid: u.id, role: u.role, scope: 'session', epoch: u.sessionEpoch || 0 }, TOKEN_TTL_MS);
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
    this.key = deriveKey(secret, 'settings-aes-gcm-v1');
    this.legacyKey = crypto.createHash('sha256').update('triboon-settings:' + secret).digest();
  }
  _encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') };
  }
  _decryptWithKey(blob, key) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8'));
  }
  _decrypt(blob) {
    try { return this._decryptWithKey(blob, this.key); }
    catch (e) { return this._decryptWithKey(blob, this.legacyKey); }
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

module.exports = { Auth, SecureSettings, RateLimiter, hashPassword, verifyPassword, deriveKey, totpCode };
