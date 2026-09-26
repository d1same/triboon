'use strict';
// Minimal NNTP client + connection pool. TLS or plain. Commands used: AUTHINFO, GROUP, STAT, BODY.

const net = require('net');
const tls = require('tls');
const debug = require('./debug');

// Stall protection — without these, ONE silently-dropped TCP connection (NAT/provider idle
// kill) makes a BODY wait forever, the mount's Promise.all never settles, and /api/play
// hangs the player on "Checking health & buffering…" indefinitely.
const CONNECT_TIMEOUT_MS = 8000;   // TCP+TLS+greeting+AUTH must complete within this
const COMMAND_TIMEOUT_MS = 8000;   // healthy responses are ~60-250ms (bench/RESULTS.md)
const MISS_CACHE_TTL_MS = 5 * 60 * 1000; // remember a definitive 430/451 per provider; timeouts never land here
const MISS_CACHE_MAX = 4000;
const IDLE_RECYCLE_MS = 30000;     // idle sockets are presumed NAT-dropped — reconnect (~150ms)
const AUTH_LOST_FRESH_MS = 15000;  // a 480 this soon after a successful AUTH is the account, not the socket
const AUTH_BROKEN_WINDOW_MS = 60000;
const AUTH_BROKEN_TRIPS = 2;
// Hedged multi-provider failover (see docs-streaming-performance.md): if an active-player BODY
// hasn't answered within this window (queued behind other work, or a provider went slow AFTER the
// load-sort), speculatively start the NEXT provider too and take the first success — so one slow
// provider costs ~HEDGE_MS, not the full COMMAND_TIMEOUT_MS. Only active-player priorities hedge,
// so background/health/read-ahead never double-fetch.
const HEDGE_MS_DEFAULT = 3000;
const HEDGE_PRIORITIES = new Set(['startup', 'seek', 'playback']);
// InfiniDysk model (github.com/infinidysk/infinidysk #913 / #916): a 502 means
// "this account is full", not "make Play wait". Learn the real cap, shrink the
// gate with ~10% teardown headroom, keep every live socket working, and spill
// the next article to another provider immediately. Never snap back to the
// typed plan — that AUTH burst is what bans the account.
const CAP_HIT_COOLDOWN_MS = 120000;
const CONNECT_BURST = 4;

function learnedConnectionLimit(e) {
  const m = /connection limit\s*\((\d+)\)/i.exec(String((e && e.message) || e || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function shrinkSizeFromLive(live, learned) {
  const cap = learned != null ? learned : live;
  if (!(cap > 0)) return 0;
  const headroom = Math.max(1, Math.floor(cap / 10));
  return Math.max(1, cap - headroom);
}

const MAX_NNTP_BODY_BYTES = 64 * 1024 * 1024; // one yEnc article should never be remotely this large

function abortError() {
  const e = new Error('NNTP command aborted');
  e.code = 'ABORT_ERR';
  return e;
}

function isAbortError(e) {
  return e && (e.code === 'ABORT_ERR' || e.name === 'AbortError');
}

function isTooManyConnections(e) {
  return /too many connection|\b502\b/i.test(String((e && e.message) || e));
}

function providerHeadroom(p) {
  const cap = Math.max(0, Number(p && p.size) || 0);
  const used = ((p && p.busy && p.busy.size) || 0) + (Number(p && p.connecting) || 0) + ((p && p.queue && p.queue.length) || 0);
  return cap - used;
}

function providerPickScore(p, needSlots = 0) {
  if (!p || (typeof p.down === 'function' && p.down())) return Infinity;
  if (typeof p.authBroken === 'function' && p.authBroken()) return Infinity;
  const cap = Math.max(1, Number(p.size) || 1);
  const used = ((p.busy && p.busy.size) || 0) + (Number(p.connecting) || 0) + ((p.queue && p.queue.length) || 0);
  let load = used / cap;
  if (p.capHitAt && Date.now() - p.capHitAt < CAP_HIT_COOLDOWN_MS) load = Math.max(load, 0.99);
  const headroom = cap - used;
  if (needSlots > 0 && headroom < needSlots) load += 10;
  else if (load >= 0.85) load += 1;
  return load;
}

// Rolling download sample from real article bodies. Play uses this instead of a
// second speed-test so evening slowness shows up without fighting the movie for
// sockets. houseMbps = home pipe fill; mbpsPerConn = fill / busy sockets.
class TransferMeter {
  constructor(windowMs = 8000) {
    this.windowMs = windowMs;
    this.events = [];
  }
  note(bytes, busy = 1) {
    const n = Number(bytes) || 0;
    if (!(n > 0)) return;
    this.events.push({ t: Date.now(), bytes: n, busy: Math.max(1, Number(busy) || 1) });
    this._trim();
  }
  _trim(now = Date.now()) {
    const cut = now - this.windowMs;
    while (this.events.length && this.events[0].t < cut) this.events.shift();
  }
  snapshot(now = Date.now()) {
    this._trim(now);
    if (!this.events.length) return { houseMbps: 0, mbpsPerConn: 0, at: 0, samples: 0 };
    const bytes = this.events.reduce((s, e) => s + e.bytes, 0);
    const t0 = this.events[0].t;
    const secs = Math.max(0.25, (now - t0) / 1000);
    const houseMbps = (bytes * 8) / 1e6 / secs;
    const busyAvg = this.events.reduce((s, e) => s + e.busy, 0) / this.events.length;
    const mbpsPerConn = houseMbps / Math.max(1, busyAvg);
    return {
      houseMbps: Number(houseMbps.toFixed(2)),
      mbpsPerConn: Number(mbpsPerConn.toFixed(2)),
      at: now,
      samples: this.events.length,
    };
  }
}

function streamStartupNeedSlots(size, priority, name) {
  if (priority !== 'startup' && priority !== 'seek') return 0;
  const bytes = Number(size) || 0;
  const label = String(name || '');
  // Same 4K rule as streamIsUhd: a 3 GB 2160p episode still needs the 4K startup
  // slot budget. Size-only treated short 4K episodes as 1080p and picked the
  // wrong provider on a multi-account box.
  const uhd = bytes > 4e9 || /\b(?:2160p|4320p|uhd|4k)\b/i.test(label);
  return uhd ? 18 : 10;
}

function signalAborted(signal) {
  return !!(signal && signal.aborted);
}

function addAbortListener(signal, fn) {
  if (!signal || typeof signal.addEventListener !== 'function') return () => {};
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

function isDefinitiveMiss(e) {
  const code = String(e && e.code || '');
  return code === '430' || code === '451';
}

// 480 = authentication required, 481/482 = authentication rejected/out of sequence (RFC 4643).
function isAuthLostStatus(status) {
  return /^48[012]\b/.test(String(status || ''));
}

function stallError(cmdName) {
  const e = new Error(`NNTP stall timeout: ${cmdName}`);
  e.code = 'NNTP_STALL';
  return e;
}

// RAM-only: skip a provider that already said "no such article" for this message-id.
// Timeouts, resets, and CRC errors must never be stored — those can heal on the next socket.
class ArticleMissCache {
  constructor({ ttlMs = MISS_CACHE_TTL_MS, max = MISS_CACHE_MAX } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  _key(provider, msgId) {
    const host = String(provider && provider.opts && provider.opts.host || '');
    const port = provider && provider.opts && provider.opts.port != null ? provider.opts.port : '';
    return `${host}:${port}|${String(msgId || '').replace(/[<>]/g, '')}`;
  }
  has(provider, msgId) {
    const key = this._key(provider, msgId);
    const exp = this.map.get(key);
    if (exp == null) return false;
    if (Date.now() >= exp) { this.map.delete(key); return false; }
    return true;
  }
  mark(provider, msgId) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(this._key(provider, msgId), Date.now() + this.ttlMs);
  }
}

class NntpConnection {
  constructor(opts) {
    this.opts = opts; // { host, port, tls, user, pass, connectTimeoutMs?, commandTimeoutMs? }
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiters = []; // FIFO of { resolve, reject, multiline, timer }
    this.alive = false;
    this.lastUsed = Date.now();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { host, port } = this.opts;
      const onConn = () => {};
      this.sock = this.opts.tls
        ? tls.connect({ host, port, rejectUnauthorized: false }, onConn)
        : net.connect({ host, port }, onConn);
      this.sock.setNoDelay(true);
      this.sock.on('data', (d) => this._onData(d));
      this.sock.on('error', (e) => this._fail(e));
      this.sock.on('close', () => this._fail(new Error('NNTP connection closed')));
      // One timer covers TCP+TLS+greeting+AUTH — _fail rejects whichever step is pending.
      this._connectTimer = setTimeout(
        () => this._fail(new Error(`NNTP connect timeout (${host}:${port})`)),
        this.opts.connectTimeoutMs || CONNECT_TIMEOUT_MS
      );
      // Server greeting is the first "response" (single-line).
      this.waiters.push({ resolve, reject, multiline: false });
    }).then(async (greeting) => {
      if (!/^20[01]/.test(greeting.status)) throw new Error(`NNTP greeting: ${greeting.status}`);
      if (this.opts.user) {
        const u = await this._cmd(`AUTHINFO USER ${this.opts.user}`);
        if (u.status.startsWith('381')) {
          const p = await this._cmd(`AUTHINFO PASS ${this.opts.pass}`);
          if (!p.status.startsWith('281')) throw new Error(`NNTP auth failed: ${p.status}`);
        } else if (!u.status.startsWith('281')) {
          throw new Error(`NNTP auth failed: ${u.status}`);
        }
      }
      clearTimeout(this._connectTimer);
      this.alive = true;
      this.lastUsed = Date.now();
      this.connectedAt = Date.now();
      return this;
    }).catch((e) => { clearTimeout(this._connectTimer); throw e; });
  }

  _fail(err) {
    const msg = String(err && err.message || '');
    // The "refused a new login" line already explained a 480 burst.
    // Later refusals on that same quiet window must not fill the log again.
    const alreadyTold = err && err.code === 'NNTP_AUTH_LOST' && this.pool && this.pool._authCapAnnounced;
    if (!alreadyTold && err && (err.code === 'NNTP_STALL' || err.code === 'NNTP_AUTH_LOST' || /connect timeout|auth failed|body too large/i.test(msg))) {
      const host = (this.opts && this.opts.host) || 'usenet';
      const waiting = (this.waiters || []).map((w) => w && w.cmdName).filter(Boolean).slice(0, 4).join(', ');
      const line = `${host}: ${msg || err.code || 'socket stopped'}${waiting ? ` while waiting on ${waiting}` : ''}`;
      debug.fail('buffer', line);
      debug.issue(`connection dropped — reason: ${line}`);
    }
    this.alive = false;
    clearTimeout(this._connectTimer);
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      clearTimeout(w.drainTimer);
      if (typeof w.cleanupAbort === 'function') w.cleanupAbort();
      w.reject(err);
    }
    try { this.sock.destroy(); } catch {}
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    // Progress on in-flight commands (NNTP responses are strictly FIFO, so waiters[0] is the one
    // being answered): reset stall timers so a slow-but-alive BODY transfer is never killed
    // mid-flight — only a genuinely wedged socket (no bytes at all for the window) trips it.
    // EVERY queued waiter is re-armed, not just the head: with pipelining more than one command
    // can be on the wire, and a waiter behind a long healthy transfer must not hit its send-time
    // window while the socket is demonstrably alive (bytes flowing = progress for the whole FIFO).
    if (d && d.length) for (const w of this.waiters) this._armWaiterTimer(w);
    while (this.waiters.length) {
      const w = this.waiters[0];
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) return;
      if (!w.statusLine) {
        w.statusLine = this.buf.toString('latin1', 0, this.buf[nl - 1] === 0x0d ? nl - 1 : nl);
        this.buf = this.buf.subarray(nl + 1);
        const code = w.statusLine.slice(0, 3);
        const isMulti = w.multiline && /^(2)/.test(code); // only 2xx carries a body
        if (!isMulti) {
          this.waiters.shift();
          clearTimeout(w.timer);
          clearTimeout(w.drainTimer);
          if (typeof w.cleanupAbort === 'function') w.cleanupAbort();
          this.lastUsed = Date.now();
          w.resolve({ status: w.statusLine, body: null });
          continue;
        }
        w.chunks = [];
      }
      // Multiline: read until CRLF.CRLF terminator.
      const term = this.buf.indexOf('\r\n.\r\n');
      if (term === -1) {
        // also handle body that begins with ".\r\n" terminator edge (empty body)
        if (this.buf.length >= 3 && this.buf[0] === 0x2e && this.buf[1] === 0x0d && this.buf[2] === 0x0a) {
          this.buf = this.buf.subarray(3);
          this.waiters.shift();
          clearTimeout(w.timer);
          clearTimeout(w.drainTimer);
          if (typeof w.cleanupAbort === 'function') w.cleanupAbort();
          this.lastUsed = Date.now();
          w.resolve({ status: w.statusLine, body: Buffer.alloc(0) });
          continue;
        }
        if (this.buf.length > MAX_NNTP_BODY_BYTES) {
          this._fail(new Error('NNTP body too large'));
          return;
        }
        return; // wait for more data
      }
      if (term > MAX_NNTP_BODY_BYTES) {
        this._fail(new Error('NNTP body too large'));
        return;
      }
      let body = this.buf.subarray(0, term + 2); // keep trailing CRLF of last line
      this.buf = this.buf.subarray(term + 5);
      // Un-dot-stuff: lines beginning ".." -> "."
      if (body.includes('\r\n..')) body = Buffer.from(body.toString('latin1').replace(/\r\n\.\./g, '\r\n.'), 'latin1');
      if (body[0] === 0x2e && body[1] === 0x2e) body = body.subarray(1);
      this.waiters.shift();
      clearTimeout(w.timer);
      clearTimeout(w.drainTimer);
      if (typeof w.cleanupAbort === 'function') w.cleanupAbort();
      this.lastUsed = Date.now();
      w.resolve({ status: w.statusLine, body });
    }
  }

  // (Re)arm a waiter's stall timer. The timeout is measured from the LAST activity, not from when
  // the command was sent: _onData re-arms it on every inbound chunk. A large BODY (a 4K segment's
  // yEnc article) or a healthy-but-slow provider — remote users on a constrained uplink — can take
  // well over COMMAND_TIMEOUT_MS to transfer in full; a hard deadline from send-time destroyed that
  // connection MID-TRANSFER (rejecting everything queued behind it → retry churn), which surfaced as
  // "plays fine, then stalls" on every client. What the timeout is really meant to catch is a WEDGED
  // socket — one making no progress — so the window is now "no bytes for this long", which fires on a
  // truly dead connection but never on a slow-but-progressing one. The multi-provider hedge still
  // races a faster provider at HEDGE_MS, so a slow transfer also loses that race and is aborted.
  _armWaiterTimer(w) {
    if (!w) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(
      () => this._fail(stallError(w.cmdName)),
      this.opts.commandTimeoutMs || COMMAND_TIMEOUT_MS
    );
  }

  _cmd(line, multiline = false, opts = {}) {
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signalAborted(signal)) return reject(abortError());
      if (!this.sock || this.sock.destroyed) return reject(new Error('NNTP not connected'));
      const w = { resolve, reject, multiline, cmdName: line.split(' ')[0] };
      // NNTP has no command cancel: once a BODY is on the wire, the only way to "abort" it is to
      // destroy the whole connection (and pay TCP+TLS+AUTH to rebuild it). For callers that opt in
      // via opts.drainMs (segment fetches), an abort mid-transfer DRAINS instead: let the response
      // finish and resolve normally — the article lands in the mount cache and the connection
      // survives for the very next seek. Without drain, a pause/skip storm on a 4K stream aborted
      // every in-flight read-ahead article and destroyed most of the pool at once (reconnect storm
      // → the NEXT seek had no connections → "gets laggy after skipping a few times"). The grace
      // bounds a slow-but-alive trickle; the per-chunk inactivity timer still kills true stalls.
      w.cleanupAbort = addAbortListener(signal, () => {
        const drainMs = opts.drainMs;
        if (!(Number.isFinite(drainMs) && drainMs > 0)) return this._fail(abortError());
        if (!w.drainTimer) {
          w.drainTimer = setTimeout(() => this._fail(abortError()), drainMs);
          if (typeof w.drainTimer.unref === 'function') w.drainTimer.unref();
        }
      });
      this._armWaiterTimer(w);
      this.waiters.push(w);
      this.lastUsed = Date.now();
      this.sock.write(line + '\r\n');
    });
  }

  // 480/481/482 on an OPEN connection means the provider forgot our AUTHINFO (session expiry,
  // idle reset, backend failover). The socket is useless from here on: every later STAT reads
  // as "missing" and every BODY fails, and the pool would keep handing it out. Destroy it so
  // the next task rebuilds a fresh, re-authenticated connection. Owner-visible symptom this
  // fixes: one title "all candidates failed" 18/18 with `480 Authentication Required` while a
  // server restart made the same releases play at once.
  _authLost(cmd, status) {
    const err = new Error(`${cmd}: ${status} (connection lost its login; reconnecting)`);
    err.code = 'NNTP_AUTH_LOST';
    this._fail(err);
    return err;
  }

  async stat(msgId, opts = {}) {
    const r = await this._cmd(`STAT <${msgId.replace(/[<>]/g, '')}>`, false, opts);
    if (isAuthLostStatus(r.status)) throw this._authLost('STAT', r.status);
    this.served = true; // a real answer means this login worked; a 480 before this is the account
    if (r.status.startsWith('223')) return true;
    // Only "no such article" is a real "missing". Any other reply (500 command unknown, 503
    // fault, 400 shutting down) is the SERVER'S problem and must not be cached as a dead source.
    if (r.status.startsWith('430') || r.status.startsWith('423')) return false;
    const err = new Error(`STAT ${msgId}: ${r.status}`);
    err.code = r.status.slice(0, 3);
    throw err;
  }

  async body(msgId, opts = {}) {
    const r = await this._cmd(`BODY <${msgId.replace(/[<>]/g, '')}>`, true, opts);
    if (!r.status.startsWith('222')) {
      if (isAuthLostStatus(r.status)) throw this._authLost('BODY', r.status);
      this.served = true;
      const err = new Error(`BODY ${msgId}: ${r.status}`);
      err.code = r.status.slice(0, 3);
      throw err;
    }
    this.served = true;
    return r.body;
  }

  close() { try { this.sock.end('QUIT\r\n'); } catch {} this.alive = false; }
}

class ProviderPool {
  constructor(opts, size = 8) {
    this.opts = opts;
    this.configuredSize = size;
    this.size = size;
    this.capHitAt = 0;
    this.conns = [];
    this.queue = []; // pending tasks { fn, resolve, reject, priority }
    this.busy = new Set();
    this.inflight = new Map(); // conn -> { n, lowOnly } (pipelining bookkeeping; busy stays the 1-per-conn source of truth)
    this.connecting = 0;   // in-flight connection attempts
    this.lastErr = null;   // most recent connect failure
    this.closed = false;
    this.authLostAt = [];  // recent 480-on-a-FRESH-login timestamps (account-level fault signal)
  }

  // A socket that logged in fine (281) and then got 480 on its first commands is not a stale
  // session — the ACCOUNT is refusing work (exhausted block, over its session cap, suspended).
  // Two such fresh failures inside the window trip the breaker: the pool stops routing to this
  // provider (others take the article at once) instead of paying connect+TLS+AUTH twice per
  // article, and Status shows "login rejected". Self-heals when the window passes.
  noteAuthLost(conn) {
    const now = Date.now();
    const fresh = conn && conn.connectedAt && now - conn.connectedAt < AUTH_LOST_FRESH_MS;
    if (fresh) {
      this.authLostAt = this.authLostAt.filter((t) => now - t < AUTH_BROKEN_WINDOW_MS);
      this.authLostAt.push(now);
      if (this.authLostAt.length > 20) this.authLostAt.shift();
    }
    // Easynews and Eweka answer 480 when the account is full, not only when a
    // socket forgot its login. A burst means "stop opening more lines".
    this._authLostRecent = (this._authLostRecent || []).filter((t) => now - t < AUTH_LOST_FRESH_MS);
    this._authLostRecent.push(now);
    if (this._authLostRecent.length > 20) this._authLostRecent.shift();
    // One forgotten login on a small pool still reconnects. A burst means
    // "do not open more lines for two minutes." The plan (the 100) stays,
    // so six people are not stuck on 4 lines after the pause.
    if (this._authLostRecent.length >= 2 && this.size > 4) this._markAuthCap();
  }
  // Easynews or Eweka already said the account is full. For two minutes, do not
  // open a new login. Lines that are already up keep downloading.
  refusingNewLogins() {
    return !!(this.authCapped && this.capHitAt && (Date.now() - this.capHitAt < CAP_HIT_COOLDOWN_MS));
  }
  hasLiveSocket() {
    return (this.conns || []).some((c) => c && c.alive);
  }
  _peerCanTakeOver() {
    return typeof this.peerCanTakeOver === 'function' && this.peerCanTakeOver();
  }
  _markAuthCap() {
    const now = Date.now();
    // Already quiet. Another 480 in this window must not open a new login.
    if (this.authCapped && now - this.capHitAt < CAP_HIT_COOLDOWN_MS) {
      this._authCapAnnounced = true;
      return;
    }
    // A 480 burst is a pause, not a new plan of 4. Easynews and Eweka still
    // allow the lines that are already signed in. Two minutes later the
    // normal share (about 4 per person, more if the house has room) comes back.
    this.capHitAt = now;
    this.lastProbeAt = now;
    this.authCapped = true;
    this._authCapAnnounced = true;
    const open = (this.conns || []).filter((c) => c && c.alive).length;
    const host = (this.opts && this.opts.host) || 'usenet';
    const refused = open > 0
      ? `${host} refused a new login, so playback is staying on the ${open} lines already open`
      : `${host} refused a new login, so playback will not open another line for two minutes`;
    debug.fail('buffer', refused);
    debug.issue(`connection dropped — reason: ${refused}`);
  }
  authBroken() {
    const now = Date.now();
    let n = 0;
    for (const t of this.authLostAt) if (now - t < AUTH_BROKEN_WINDOW_MS) n++;
    return n >= AUTH_BROKEN_TRIPS;
  }

  // Open all missing connections IN PARALLEL (non-blocking). Each becomes available to the
  // dispatcher as soon as its TLS+AUTH handshake completes — work starts on the first ready
  // connection instead of waiting for the whole pool. Sequential connect was the dominant
  // mount-time cost against a real provider (16 × ~150ms handshakes).
  // Pre-open a few connections so the FIRST play after boot doesn't pay the TLS+AUTH wall.
  warm(n = 4) {
    this._ensure(Math.min(n, this.size));
  }

  _markCapHit(err) {
    this.capHitAt = Date.now();
    this.lastProbeAt = Date.now();
    const next = shrinkSizeFromLive(this.conns.length, learnedConnectionLimit(err));
    if (next < this.size) this.size = next;
    const host = (this.opts && this.opts.host) || 'usenet';
    const full = `${host} is full, so playback is using ${this.size} connections`;
    debug.fail('buffer', full);
    debug.issue(`connection dropped — reason: ${full}`);
  }

  _admitConn(c) {
    const limit = this._playbackCap() ? this._openLimit() : this.size;
    if (this.closed || this.conns.length >= limit) {
      try { c.close(); } catch {}
      return false;
    }
    this.conns.push(c);
    return true;
  }

  _ensure(target = this.size) {
    if (this.closed) return;
    // A fresh 502 or 480 burst already told us the account is full. Replacing
    // closed sockets immediately is what keeps Newshosting at 82 and makes
    // Easynews/Eweka answer 480. Hold still, except one probe when nothing is left.
    if (this.capHitAt && Date.now() - this.capHitAt < CAP_HIT_COOLDOWN_MS && (this.conns.length > 0 || this.connecting > 0)) return;
    // Quiet window: no new login at all, even a single probe. The lines already
    // open keep working. A probe here is what asked Easynews and Eweka again.
    if (this.refusingNewLogins() && !this.hasLiveSocket()) return;
    const fullyDark = this.down() || (this.capHitAt && this.conns.length === 0);
    if (fullyDark) {
      // Half-open probe only when this provider has ZERO live sockets. Play already
      // spilled to the next account — this is recovery, not a user wait.
      const probeMs = this.opts.reconnectProbeMs || 8000;
      if (this.connecting > 0 || Date.now() - (this.lastProbeAt || 0) < probeMs) return;
      this.lastProbeAt = Date.now();
      target = 1;
      if (this.size < 1) this.size = 1;
    }
    const room = this._playbackCap() ? this._openLimit() : target;
    const want = Math.min(target, this.size, room);
    while (!this.closed && this.conns.length + this.connecting < want && this.connecting < CONNECT_BURST) {
      this.connecting++;
      const c = new NntpConnection(this.opts);
      c.pool = this;
      c.connect().then(() => {
        this.connecting--;
        if (this._admitConn(c)) this._pump();
      }, (e) => {
        this.connecting--;
        this.lastErr = e;
        this.lastConnectFailAt = Date.now();
        if (e && /auth failed/i.test(String(e.message || ''))) {
          const authLost = /48[012]/.test(String(e.message || ''));
          // Login itself got 480. That is the same full account as a STAT 480.
          // Say it once, then stop opening sockets.
          if (authLost) {
            if (!this._authCapAnnounced) this._markAuthCap();
          } else {
            const authLine = `${(this.opts && this.opts.host) || 'usenet'}: ${e.message}`;
            debug.fail('buffer', authLine);
            debug.issue(`connection dropped — reason: ${authLine}`);
          }
        }
        try { c.close(); } catch {}
        if (isTooManyConnections(e)) this._markCapHit(e);
        // If every attempt failed and nothing is live, queued work can never run — fail it.
        if (this.connecting === 0 && this.conns.length === 0 && this.queue.length) {
          const q = this.queue; this.queue = [];
          for (const t of q) { if (typeof t.cleanupAbort === 'function') t.cleanupAbort(); t.reject(e); }
        } else {
          this._pump();
        }
      });
    }
  }

  _priorityRank(priority) {
    return ({ startup: 0, seek: 0, playback: 1, health: 2, readAhead: 3, background: 4 })[priority] ?? 1;
  }

  // Run fn(conn) on a free connection; queue by priority if all busy.
  run(fn, priority = 'playback', opts = {}) {
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signalAborted(signal)) return reject(abortError());
      const task = { fn, resolve, reject, priority, signal };
      task.cleanupAbort = addAbortListener(signal, () => {
        const idx = this.queue.indexOf(task);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          task.cleanupAbort();
          reject(abortError());
        }
      });
      this.queue.push(task);
      this._pump();
    });
  }

  // True if any queued (non-aborted) task is active-player work — startup/seek/playback (rank
   // ≤ playback). Such work bypasses the read-ahead connection reserve and may use the whole pool.
  _hasActivePlayerWorkQueued() {
    const playbackRank = this._priorityRank('playback');
    for (const t of this.queue) {
      if (signalAborted(t.signal)) continue;
      if (this._priorityRank(t.priority) <= playbackRank) return true;
    }
    return false;
  }

  _shiftTask() {
    while (this.queue.length) {
      if (this.queue.length <= 1) {
        const task = this.queue.shift();
        if (signalAborted(task.signal)) {
          if (typeof task.cleanupAbort === 'function') task.cleanupAbort();
          task.reject(abortError());
          continue;
        }
        return task;
      }
      let best = 0, rank = this._priorityRank(this.queue[0].priority);
      for (let i = 1; i < this.queue.length; i++) {
        const r = this._priorityRank(this.queue[i].priority);
        if (r < rank) { best = i; rank = r; }
      }
      const task = this.queue.splice(best, 1)[0];
      if (signalAborted(task.signal)) {
        if (typeof task.cleanupAbort === 'function') task.cleanupAbort();
        task.reject(abortError());
        continue;
      }
      return task;
    }
    return null;
  }

  _pump() {
    // Cull FIRST: dead sockets and long-idle ones (NAT/provider silently drops idle NNTP
    // connections — writing into one hangs until the command timeout). Culling before the
    // _ensure accounting also guarantees dead conns never block reconnection.
    const now = Date.now();
    const idleMs = this.opts.idleRecycleMs || IDLE_RECYCLE_MS;
    this.conns = this.conns.filter((c) => {
      if (!c.alive) return false;
      // During the quiet window an idle line is still a good login. Closing it
      // would force a new AUTH, and that AUTH is what gets the next 480.
      if (!this.busy.has(c) && !this.refusingNewLogins() && now - c.lastUsed > idleMs) { c.close(); return false; }
      return true;
    });
    if (this.queue.length && this.conns.length === 0 && this.connecting === 0 && this.down()) {
      this._ensure(this._openLimit()); // give the breaker a throttled half-open probe before failing work over
      if (this.connecting > 0) return; // probing — its resolve (recovered) / reject (still down) re-pumps
      const q = this.queue; this.queue = [];
      const err = this.lastErr || new Error('provider temporarily unavailable');
      for (const t of q) { if (typeof t.cleanupAbort === 'function') t.cleanupAbort(); t.reject(err); }
      return;
    }
    // A movie follows Streaming settings, not the account maximum. One title
    // used to dial every line the plan allows (50 on Eweka, 40 on the next
    // account) because any queued article grew the pool to this.size.
    const limit = this._openLimit();
    if (this._playbackCap() && this.conns.length > limit) {
      for (const c of this.conns) {
        if (this.conns.filter((x) => x.alive).length <= limit) break;
        if (!c.alive || this.busy.has(c)) continue;
        try { c.close(); } catch {}
        c.alive = false;
      }
      this.conns = this.conns.filter((c) => c.alive);
    }
    const ceiling = this._playbackCap() ? limit : this.size;
    // One queued article is one login. The admin share is the ceiling once that
    // many articles are actually waiting — not a reason to AUTH 12 sockets for
    // a single STAT. Opening the whole share on the first command is what made
    // Easynews and Eweka answer 480 before the movie had started.
    let pending = 0;
    for (const t of this.queue) if (!signalAborted(t.signal) && !t.stayOnLive) pending++;
    const openNow = this.conns.length + this.connecting;
    const need = Math.min(ceiling, Math.max(openNow, pending));
    if (pending && openNow < need) this._ensure(need);
    // Active-player connection reserve: read-ahead/background must NEVER occupy the last
    // `reserve` idle connections. Otherwise read-ahead (up to maxConnPerStream) saturates the
    // pool and the next-needed PLAYBACK segment waits for a read-ahead fetch to finish to get a
    // connection — a multi-second head-of-line stall (the "plays fine then buffers after a couple
    // minutes" bug: the startup/seek burst fills the buffer, then every stall drains it). The pool
    // already prioritises the QUEUE, but priority can't preempt an in-flight fetch — only a free
    // connection can. Startup/seek/playback bypass the reserve and may use every connection; see
    // docs-streaming-performance.md ("read-ahead must never outrank bytes needed by the player").
    const playbackReserve = this.opts.playbackReserve != null
      ? this.opts.playbackReserve
      : (this.size >= 4 ? 2 : 1);
    const reserve = Math.max(0, Math.min(playbackReserve, this.size - 1));
    for (const c of this.conns) {
      if (!this.queue.length) break;
      if (this.busy.has(c) || !c.alive) continue;
      // Hold the reserved connections idle for the active player unless the highest-priority
      // queued work IS active-player work (startup/seek/playback), which may use the whole pool.
      if (reserve > 0 && !this._hasActivePlayerWorkQueued()) {
        const idleFree = this.conns.reduce((n, x) => n + ((x.alive && !this.busy.has(x)) ? 1 : 0), 0);
        const alive = this.conns.reduce((n, x) => n + (x.alive ? 1 : 0), 0);
        // Keep the spare sockets idle for the player. If every socket is inside
        // that spare, the article would wait forever — do the work instead.
        if (idleFree <= reserve && idleFree < alive) break;
      }
      const task = this._shiftTask();
      if (!task) break;
      if (typeof task.cleanupAbort === 'function') task.cleanupAbort();
      this._launch(c, task);
    }
    // Opt-in NNTP pipelining (TRIBOON_NNTP_PIPELINE=2..4, default off): stack ADDITIONAL low-lane
    // (readAhead/background) fetches onto connections already running ONLY low-lane work, up to
    // `depth` in flight per socket. NNTP answers strictly in order (the connection's waiter FIFO
    // maps responses back), and keeping the socket's request queue non-empty hides one RTT per
    // article (the SABnzbd 5.0.4 / nzbfast tactic). Startup/seek/playback/health NEVER share a
    // socket: a pipelined queue would park the player's bytes behind a read-ahead transfer
    // (head-of-line), so high lanes keep the one-command-per-connection contract and the idle
    // dispatch above. This pass consumes no idle connections at all, so the playback reserve is
    // untouched — it only raises throughput on sockets read-ahead already owns.
    // The stacking pass stands down ENTIRELY while any above-low work (startup/seek/playback/
    // health) is queued: those tasks are waiting for a socket to fully drain, and stacking more
    // read-ahead onto a draining socket would park them behind it — the exact priority inversion
    // the lanes exist to prevent.
    const depth = this._pipelineDepth();
    if (depth > 1 && !this._hasAboveLowQueued()) {
      for (const c of this.conns) {
        if (!this.queue.length) break;
        if (!c.alive) continue;
        const st = this.inflight.get(c);
        if (!st || !st.lowOnly) continue;
        while (st.n < depth && this.queue.length) {
          const task = this._shiftLowTask();
          if (!task) break;
          if (typeof task.cleanupAbort === 'function') task.cleanupAbort();
          this._launch(c, task);
        }
      }
    }
  }

  _hasAboveLowQueued() {
    const lowRank = this._priorityRank('readAhead');
    for (const t of this.queue) {
      if (signalAborted(t.signal)) continue;
      if (this._priorityRank(t.priority) < lowRank) return true;
    }
    return false;
  }

  // Run one task on a connection with in-flight bookkeeping. `busy` keeps meaning "has ≥1
  // in-flight command" (idle/cull/reserve checks are unchanged); `inflight` carries the count and
  // whether every command on the socket is low-lane (the only mix pipelining may stack onto).
  _launch(c, task) {
    const low = this._priorityRank(task.priority) >= this._priorityRank('readAhead');
    const st = this.inflight.get(c) || { n: 0, lowOnly: true };
    st.n++;
    if (!low) st.lowOnly = false;
    this.inflight.set(c, st);
    this.busy.add(c);
    task.fn(c)
      .then(task.resolve, (e) => {
        // An NNTP status reply (e.code = '430' etc.) is a real answer — pass it through.
        // A connection-level failure (timeout/closed/reset) gets ONE retry on a fresh
        // connection so a single dead socket can't sink a whole mount.
        if (e && e.code === 'NNTP_AUTH_LOST') this.noteAuthLost(c);
        if (!isAbortError(e) && !task.retried && !/^\d{3}$/.test(String(e && e.code || ''))) {
          // One dead socket must not sink a solo-provider mount. With a second provider ready,
          // leave immediately so the stall window is paid once, on the next host — not twice here.
          if (e && e.code === 'NNTP_STALL' && this.preferPeerFailover) task.reject(e);
          // The piece was on a line the provider just forgot. Another line is
          // already signed in. Move the piece there. Signing in again is the wait.
          else if (e && e.code === 'NNTP_AUTH_LOST' && this.hasLiveSocket()) {
            task.stayOnLive = true;
            this.queue.push(task);
          }
          // A brand-new socket that 480s never finished a command. Logging in
          // again on the same account is a second strike, not a retry.
          // Once the account is quiet, only a peer that can still take the piece
          // gets it. If that peer also said no, do not open a login on either.
          else if (e && e.code === 'NNTP_AUTH_LOST' && this._peerCanTakeOver()
              && (!(c && c.served) || this.authBroken() || this.authCapped || this.refusingNewLogins())) task.reject(e);
          else if (e && e.code === 'NNTP_AUTH_LOST' && this.refusingNewLogins()) task.reject(e);
          else { task.retried = true; task.stayOnLive = false; this.queue.push(task); }
        } else task.reject(e);
      })
      .finally(() => {
        const cur = this.inflight.get(c);
        if (cur && --cur.n <= 0) { this.inflight.delete(c); this.busy.delete(c); }
        this._pump();
      });
  }

  // Lowest-rank low-lane task (readAhead/background) for the pipelining pass. Aborted entries are
  // left in place for _shiftTask's normal cleanup path.
  _shiftLowTask() {
    const lowRank = this._priorityRank('readAhead');
    let best = -1, rank = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      const t = this.queue[i];
      if (signalAborted(t.signal)) continue;
      const r = this._priorityRank(t.priority);
      if (r >= lowRank && r < rank) { best = i; rank = r; }
    }
    return best === -1 ? null : this.queue.splice(best, 1)[0];
  }

  // 0 is tests and tools only: they may use the pool size they passed in.
  // A real server always sets a positive cap (one viewer's admin share).
  // That cap is the household total for every usenet account together.
  _playbackCap() {
    if (typeof this.playbackOpenCap !== 'function') return 0;
    const n = Number(this.playbackOpenCap());
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  _openLimit() {
    const cap = this._playbackCap();
    if (!cap) return this.size;
    const open = typeof this.householdOpen === 'function'
      ? this.householdOpen()
      : (this.conns.length + this.connecting);
    const others = Math.max(0, open - this.conns.length - this.connecting);
    return Math.min(this.size, Math.max(0, cap - others));
  }

  _pipelineDepth() {
    const v = this.opts.pipelineDepth != null
      ? +this.opts.pipelineDepth
      : parseInt(process.env.TRIBOON_NNTP_PIPELINE || '0', 10);
    return Number.isFinite(v) && v > 1 ? Math.min(4, v) : 0;
  }

  stat(msgId, priority = 'health', opts = {}) { return this.run((c) => c.stat(msgId, opts), priority, opts); }
  body(msgId, priority = 'playback', opts = {}) {
    return this.run(async (c) => {
      const buf = await c.body(msgId, opts);
      if (this.meter) this.meter.note(buf && buf.length, this.busy.size);
      return buf;
    }, priority, opts);
  }
  // Circuit breaker: a provider with zero live connections and a connect failure in the last
  // 60s is "down" — multi-provider routing deprioritizes it instead of paying the failure on
  // EVERY article. It self-heals: after 60s (or one successful connect) it's back in rotation.
  down() {
    const backoffMs = this.opts.reconnectBackoffMs || 60000;
    return this.conns.length === 0 && !!this.lastConnectFailAt && Date.now() - this.lastConnectFailAt < backoffMs;
  }
  // Instantaneous connection snapshot for the admin Activity screen. Never includes credentials —
  // only the host and live counts. inUse = connections actively running a command right now.
  stats() {
    return {
      host: String(this.opts.host || ''),
      inUse: this.busy.size,
      open: this.conns.length,
      connecting: this.connecting,
      size: this.size,
      queued: this.queue.length,
      down: this.down(),
      authBroken: this.authBroken(),
    };
  }
  close() { this.closed = true; for (const c of this.conns) c.close(); this.conns = []; }
}

// Multi-provider pool with per-article failover: a 430 (or dead connection) on one provider
// transparently retries the next, in configured order. Single-opts construction keeps the
// Phase 0 signature working.
class NntpPool {
  constructor(optsOrList, size = 8) {
    const list = Array.isArray(optsOrList) ? optsOrList : [optsOrList];
    // Each provider honors its own connection limit (falls back to the pool default).
    this.providers = list.map((o) => new ProviderPool(o, o.connections || size));
    this.opts = list[0];
    this.size = size;
    this.missCache = new ArticleMissCache();
    this.meter = new TransferMeter();
    const preferPeerFailover = this.providers.length > 1;
    const self = this;
    for (const p of this.providers) {
      p.preferPeerFailover = preferPeerFailover;
      p.meter = this.meter;
      // A peer can take the piece when it is not in the two-minute quiet window,
      // or when it still has a line that is already logged in.
      p.peerCanTakeOver = () => self.providers.some((o) => {
        if (o === p) return false;
        if (typeof o.authBroken === 'function' && o.authBroken()) return false;
        if (typeof o.refusingNewLogins === 'function' && o.refusingNewLogins() && !o.hasLiveSocket()) return false;
        return true;
      });
    }
  }

  // One account, one socket, until a movie actually needs more. Warming every
  // provider at boot (4 + 2 + 2 + 2) left idle logins on Easynews and Eweka
  // before anyone pressed play. A single-provider pool can still warm `n`.
  warm(n = 1) {
    if (!this.providers.length) return;
    if (this.providers.length === 1) this.providers[0].warm(n);
    else this.providers[0].warm(1);
  }

  // While a movie or show is playing, this is how many usenet lines the whole
  // house may hold open. Local library files never set it. 0 clears the cap.
  setPlaybackOpenCap(n) {
    const cap = Math.max(0, Math.floor(Number(n) || 0));
    this._playbackOpenCap = cap;
    const self = this;
    for (const p of this.providers) {
      p.playbackOpenCap = () => self._playbackOpenCap;
      p.householdOpen = () => self.providers.reduce((sum, x) => sum + x.conns.length + (x.connecting || 0), 0);
    }
    // Drop idle logins that are already over the new share. Waiting for the
    // next article is how a previous play left 40 sockets up.
    for (const p of this.providers) {
      try { p._pump(); } catch {}
    }
  }

  // COMBINED multi-provider mode: each article goes to the healthiest provider with room.
  // Score is used/size. A provider at ≥85% (or a fresh 502) is pushed back so a new Play
  // spills to Newshosting while Easynews is full, instead of opening the 502. Tie at idle
  // prefers the larger unused plan so we do not fill the 50-cap account first. A circuit-
  // broken provider sinks to the back but is still tried last (a wrong breaker cannot lose
  // an article). If the winner does not have the article, body() fails over as before.
  _ordered(needSlots = 0) {
    if (this.providers.length === 1) return this.providers;
    const need = Math.max(0, Number(needSlots) || 0);
    // An account that rejects logins (480 on fresh sockets) is skipped outright while any other
    // provider is usable: trying it "last" would still cost connect+TLS+AUTH on every article the
    // healthy accounts do not have. It rejoins by itself when its breaker window passes.
    const broken = (p) => typeof p.authBroken === 'function' && p.authBroken();
    const refusing = (p) => typeof p.refusingNewLogins === 'function' && p.refusingNewLogins();
    const live = (p) => typeof p.hasLiveSocket === 'function' && p.hasLiveSocket();
    const usable = this.providers.filter((p) => !broken(p));
    let list;
    if (usable.length) {
      // An account that just refused new logins is not dialed again while
      // another account can take the piece. A line it already has stays usable.
      const keep = usable.filter((p) => !refusing(p) || live(p));
      // No open line on a full account means do not dial it. One "just in case"
      // login was enough to get another 480 on the next episode.
      list = keep;
    } else {
      // Every account said no. Keep downloading on a line that is already open.
      // If none is open, dialing all of them again is what filled the log.
      const stillUp = this.providers.filter(live);
      list = stillUp.length ? stillUp : [];
    }
    return [...list].sort((a, b) => {
      const ha = providerHeadroom(a);
      const hb = providerHeadroom(b);
      const aFit = need <= 0 || ha >= need;
      const bFit = need <= 0 || hb >= need;
      if (aFit !== bFit) return aFit ? -1 : 1;
      if (!aFit && !bFit) return hb - ha;
      const sa = providerPickScore(a, need);
      const sb = providerPickScore(b, need);
      if (sa !== sb) return sa - sb;
      return hb - ha;
    });
  }

  // True if ANY provider has the article.
  // opts.parallel: ask every usable provider at once and settle on the first 223. The press-play
  // first-article probe has an 800ms budget; walking four accounts one 430 at a time (~4 RTT) blew
  // it on most dead copies, so those fell through to the far slower BODY mount chain instead of
  // being skipped in one round trip. Health triage keeps the sequential, load-friendly walk.
  _nobodyCanAnswer() {
    const e = new Error('no usenet provider reachable');
    e.code = 'NO_PROVIDER';
    return e;
  }

  async stat(msgId, priority = 'health', opts = {}) {
    if (opts.parallel && this.providers.length > 1) return this._parallelStat(msgId, priority, opts);
    const ordered = this._ordered(opts.needSlots);
    // Both accounts refused. That is not "this file is missing".
    if (!ordered.length && this.providers.length) throw this._nobodyCanAnswer();
    let reachedAny = false; // did at least one provider actually ANSWER (vs. all connections failing)?
    for (const p of ordered) {
      if (this.missCache.has(p, msgId)) continue;
      try {
        const ok = await p.stat(msgId, priority, opts);
        reachedAny = true;            // a real answer (present, or a 430 not-found) came back
        if (ok) return true;
      } catch (e) {
        if (isAbortError(e)) throw e;
        /* provider down -> try next */
      }
    }
    // Distinguish "no provider HAS it" (genuine missing) from "no provider was REACHABLE" (a
    // connection / auth / VPN / port problem). Without this, both collapse to `false` and the caller
    // mislabels an unreachable server as a removed article ("18 removed/missing — add indexers").
    if (!reachedAny && opts.throwIfUnreachable) {
      const e = new Error('no usenet provider reachable');
      e.code = 'NO_PROVIDER';
      throw e;
    }
    return false;
  }

  _parallelStat(msgId, priority, opts = {}) {
    const ordered = this._ordered(opts.needSlots).filter((p) => !this.missCache.has(p, msgId));
    if (!ordered.length && this.providers.length) return Promise.reject(this._nobodyCanAnswer());
    const alreadyIn = ordered.filter((p) => (p.conns || []).some((c) => c.alive));
    // Reuse logins we already hold. A cold check opens one new login, not one
    // per account. Four simultaneous AUTHs for one STAT is a throttle.
    const providers = alreadyIn.length ? alreadyIn : ordered.slice(0, 1);
    if (!providers.length) return Promise.resolve(false);
    // The caller's abort only stops WAITING. The STATs themselves run to completion: a STAT
    // answers in one round trip, hard-aborting the losers would destroy their connections
    // (TCP+TLS+AUTH to rebuild) on every successful probe, and a late 430 still feeds the miss
    // cache for the BODY chain that follows.
    const { signal, ...rest } = opts;
    return new Promise((resolve, reject) => {
      let pending = providers.length;
      let reachedAny = false;
      let settled = false;
      const extCleanup = addAbortListener(signal, () => { if (!settled) { settled = true; reject(abortError()); } });
      const finish = (fn) => { if (settled) return; settled = true; extCleanup(); fn(); };
      if (signalAborted(signal)) return finish(() => reject(abortError()));
      for (const p of providers) {
        p.stat(msgId, priority, rest).then(
          (ok) => {
            if (ok) return finish(() => resolve(true));
            reachedAny = true;
            this.missCache.mark(p, msgId);
            if (--pending === 0) finish(() => resolve(false));
          },
          (e) => {
            if (/^\d{3}$/.test(String(e && e.code || ''))) reachedAny = true; // a real NNTP answer, just not 223/430
            if (--pending === 0) {
              if (!reachedAny && rest.throwIfUnreachable) {
                const err = new Error('no usenet provider reachable');
                err.code = 'NO_PROVIDER';
                return finish(() => reject(err));
              }
              finish(() => resolve(false));
            }
          },
        );
      }
    });
  }

  async body(msgId, priority = 'playback', opts = {}) {
    const ordered = this._ordered(opts.needSlots);
    if (!ordered.length) throw this.providers.length ? this._nobodyCanAnswer() : new Error('no usenet providers configured');
    // Plain sequential failover for single-provider setups and non-critical work (no speculative
    // double-fetch): a 430/connection error advances immediately to the next provider.
    if (ordered.length === 1 || !HEDGE_PRIORITIES.has(priority)) {
      let lastErr;
      for (const p of ordered) {
        if (this.missCache.has(p, msgId)) continue;
        try { return await p.body(msgId, priority, opts); }
        catch (e) {
          if (isAbortError(e)) throw e;
          if (isDefinitiveMiss(e)) this.missCache.mark(p, msgId);
          lastErr = e;
        }
      }
      throw lastErr || new Error('no usenet provider could serve the article');
    }
    return this._hedgedBody(ordered, msgId, priority, opts);
  }

  // Hedged failover across providers: start provider 0; if it hasn't answered within HEDGE_MS
  // (slow / queued), ALSO start the next provider without cancelling the first, and take whichever
  // resolves first — then abort the losers. A genuine failure (430 / connection error) advances
  // immediately rather than waiting for the hedge timer. Bounds a slow provider's cost to ~HEDGE_MS
  // instead of COMMAND_TIMEOUT_MS while preserving load-based ordering and per-provider retry.
  _hedgedBody(ordered, msgId, priority, opts) {
    const hedgeMs = Number(opts.hedgeMs) > 0 ? Number(opts.hedgeMs) : HEDGE_MS_DEFAULT;
    const external = opts.signal || null;
    return new Promise((resolve, reject) => {
      if (signalAborted(external)) return reject(abortError());
      let idx = 0, pending = 0, settled = false, lastErr = null, hedgeTimer = null;
      const controllers = [];
      let extCleanup = () => {};
      const clearHedge = () => { if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; } };
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        clearHedge();
        extCleanup();
        for (const c of controllers) { try { c.abort(); } catch {} } // abort the losing (or unstarted-signal) attempts
        fn();
      };
      const armHedge = () => {
        clearHedge();
        if (idx >= ordered.length) return; // no more providers to speculate onto
        // Only player lanes reach this function. Health and read-ahead stay on
        // one provider until it actually fails, so a slow check does not log in next.
        hedgeTimer = setTimeout(() => { hedgeTimer = null; startNext(); }, hedgeMs);
        if (hedgeTimer && hedgeTimer.unref) hedgeTimer.unref();
      };
      const quietWithNoLine = (p) => p && typeof p.refusingNewLogins === 'function' && p.refusingNewLogins()
        && !(typeof p.hasLiveSocket === 'function' && p.hasLiveSocket());
      const startNext = (allowNewLogin = true) => {
        if (settled) return;
        while (idx < ordered.length && this.missCache.has(ordered[idx], msgId)) idx++;
        while (idx < ordered.length && quietWithNoLine(ordered[idx])) idx++;
        if (!allowNewLogin) {
          while (idx < ordered.length && !(ordered[idx].conns || []).some((c) => c.alive)) idx++;
        }
        if (idx >= ordered.length) {
          if (pending === 0) settle(() => reject(lastErr || new Error('no usenet provider could serve the article')));
          return;
        }
        const p = ordered[idx++];
        pending++;
        const ac = new AbortController();
        controllers.push(ac);
        p.body(msgId, priority, { ...opts, signal: ac.signal }).then(
          (v) => settle(() => resolve(v)),
          (e) => {
            pending--;
            if (settled) return;
            if (ac.signal.aborted && isAbortError(e)) return; // a loser we aborted on success — ignore
            if (isAbortError(e) && signalAborted(external)) return settle(() => reject(e));
            if (isDefinitiveMiss(e)) this.missCache.mark(p, msgId);
            lastErr = e;
            startNext(); // failure advances immediately, don't wait out the hedge window
            if (pending === 0 && idx >= ordered.length) settle(() => reject(lastErr || new Error('no usenet provider could serve the article')));
          },
        );
        armHedge();
      };
      extCleanup = addAbortListener(external, () => settle(() => reject(abortError())));
      startNext();
    });
  }

  async run(fn, priority = 'playback', opts = {}) {
    let lastErr;
    for (const p of this._ordered(opts.needSlots)) {
      try { return await p.run(fn, priority, opts); } catch (e) { if (isAbortError(e)) throw e; lastErr = e; }
    }
    throw lastErr || new Error('no NNTP providers available');
  }
  // Per-provider + aggregate connection usage for the admin Activity screen.
  stats() {
    const providers = this.providers.map((p) => p.stats());
    return {
      providers,
      inUse: providers.reduce((n, p) => n + p.inUse, 0),
      open: providers.reduce((n, p) => n + p.open, 0),
      size: providers.reduce((n, p) => n + p.size, 0),
      queued: providers.reduce((n, p) => n + p.queued, 0),
      throughput: this.meter ? this.meter.snapshot() : { houseMbps: 0, mbpsPerConn: 0, at: 0, samples: 0 },
    };
  }
  close() { for (const p of this.providers) p.close(); }
}

module.exports = {
  NntpConnection, NntpPool, ProviderPool, ArticleMissCache, TransferMeter, isTooManyConnections,
  providerPickScore, providerHeadroom, streamStartupNeedSlots,
  learnedConnectionLimit, shrinkSizeFromLive, CAP_HIT_COOLDOWN_MS, CONNECT_BURST,
};
