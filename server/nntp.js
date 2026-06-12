'use strict';
// Minimal NNTP client + connection pool. TLS or plain. Commands used: AUTHINFO, GROUP, STAT, BODY.

const net = require('net');
const tls = require('tls');

// Stall protection — without these, ONE silently-dropped TCP connection (NAT/provider idle
// kill) makes a BODY wait forever, the mount's Promise.all never settles, and /api/play
// hangs the player on "Checking health & buffering…" indefinitely.
const CONNECT_TIMEOUT_MS = 8000;   // TCP+TLS+greeting+AUTH must complete within this
const COMMAND_TIMEOUT_MS = 10000;  // healthy responses are ~60-250ms (bench/RESULTS.md)
const IDLE_RECYCLE_MS = 30000;     // idle sockets are presumed NAT-dropped — reconnect (~150ms)

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
      return this;
    }).catch((e) => { clearTimeout(this._connectTimer); throw e; });
  }

  _fail(err) {
    this.alive = false;
    clearTimeout(this._connectTimer);
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) { clearTimeout(w.timer); w.reject(err); }
    try { this.sock.destroy(); } catch {}
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
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
          this.lastUsed = Date.now();
          w.resolve({ status: w.statusLine, body: Buffer.alloc(0) });
          continue;
        }
        return; // wait for more data
      }
      let body = this.buf.subarray(0, term + 2); // keep trailing CRLF of last line
      this.buf = this.buf.subarray(term + 5);
      // Un-dot-stuff: lines beginning ".." -> "."
      if (body.includes('\r\n..')) body = Buffer.from(body.toString('latin1').replace(/\r\n\.\./g, '\r\n.'), 'latin1');
      if (body[0] === 0x2e && body[1] === 0x2e) body = body.subarray(1);
      this.waiters.shift();
      clearTimeout(w.timer);
      this.lastUsed = Date.now();
      w.resolve({ status: w.statusLine, body });
    }
  }

  _cmd(line, multiline = false) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('NNTP not connected'));
      const w = { resolve, reject, multiline };
      // A timed-out command means a dead or wedged socket — kill the connection (rejecting
      // anything queued behind it) rather than leaving the caller waiting forever.
      w.timer = setTimeout(
        () => this._fail(new Error(`NNTP timeout: ${line.split(' ')[0]}`)),
        this.opts.commandTimeoutMs || COMMAND_TIMEOUT_MS
      );
      this.waiters.push(w);
      this.lastUsed = Date.now();
      this.sock.write(line + '\r\n');
    });
  }

  async stat(msgId) {
    const r = await this._cmd(`STAT <${msgId.replace(/[<>]/g, '')}>`);
    return r.status.startsWith('223');
  }

  async body(msgId) {
    const r = await this._cmd(`BODY <${msgId.replace(/[<>]/g, '')}>`, true);
    if (!r.status.startsWith('222')) {
      const err = new Error(`BODY ${msgId}: ${r.status}`);
      err.code = r.status.slice(0, 3);
      throw err;
    }
    return r.body;
  }

  close() { try { this.sock.end('QUIT\r\n'); } catch {} this.alive = false; }
}

class ProviderPool {
  constructor(opts, size = 8) {
    this.opts = opts;
    this.size = size;
    this.conns = [];
    this.queue = []; // pending tasks { fn, resolve, reject }
    this.busy = new Set();
    this.connecting = 0;   // in-flight connection attempts
    this.lastErr = null;   // most recent connect failure
    this.closed = false;
  }

  // Open all missing connections IN PARALLEL (non-blocking). Each becomes available to the
  // dispatcher as soon as its TLS+AUTH handshake completes — work starts on the first ready
  // connection instead of waiting for the whole pool. Sequential connect was the dominant
  // mount-time cost against a real provider (16 × ~150ms handshakes).
  // Pre-open a few connections so the FIRST play after boot doesn't pay the TLS+AUTH wall.
  warm(n = 4) {
    this._ensure(Math.min(n, this.size));
  }

  _ensure(target = this.size) {
    while (!this.closed && this.conns.length + this.connecting < target) {
      this.connecting++;
      const c = new NntpConnection(this.opts);
      c.connect().then(() => {
        this.connecting--;
        if (this.closed) { c.close(); return; }
        this.conns.push(c);
        this._pump();
      }, (e) => {
        this.connecting--;
        this.lastErr = e;
        this.lastConnectFailAt = Date.now();
        // If every attempt failed and nothing is live, queued work can never run — fail it.
        if (this.connecting === 0 && this.conns.length === 0 && this.queue.length) {
          const q = this.queue; this.queue = [];
          for (const t of q) t.reject(e);
        } else {
          this._pump();
        }
      });
    }
  }

  // Run fn(conn) on a free connection; queue if all busy.
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    // Cull FIRST: dead sockets and long-idle ones (NAT/provider silently drops idle NNTP
    // connections — writing into one hangs until the command timeout). Culling before the
    // _ensure accounting also guarantees dead conns never block reconnection.
    const now = Date.now();
    const idleMs = this.opts.idleRecycleMs || IDLE_RECYCLE_MS;
    this.conns = this.conns.filter((c) => {
      if (!c.alive) return false;
      if (!this.busy.has(c) && now - c.lastUsed > idleMs) { c.close(); return false; }
      return true;
    });
    if (this.queue.length && this.conns.length + this.connecting < this.size) this._ensure();
    for (const c of this.conns) {
      if (!this.queue.length) break;
      if (this.busy.has(c) || !c.alive) continue;
      const task = this.queue.shift();
      this.busy.add(c);
      task.fn(c)
        .then(task.resolve, (e) => {
          // An NNTP status reply (e.code = '430' etc.) is a real answer — pass it through.
          // A connection-level failure (timeout/closed/reset) gets ONE retry on a fresh
          // connection so a single dead socket can't sink a whole mount.
          if (!task.retried && !/^\d{3}$/.test(String(e && e.code || ''))) {
            task.retried = true;
            this.queue.push(task);
          } else task.reject(e);
        })
        .finally(() => { this.busy.delete(c); this._pump(); });
    }
  }

  stat(msgId) { return this.run((c) => c.stat(msgId)); }
  body(msgId) { return this.run((c) => c.body(msgId)); }
  // Circuit breaker: a provider with zero live connections and a connect failure in the last
  // 60s is "down" — multi-provider routing deprioritizes it instead of paying the failure on
  // EVERY article. It self-heals: after 60s (or one successful connect) it's back in rotation.
  down() {
    return this.conns.length === 0 && !!this.lastConnectFailAt && Date.now() - this.lastConnectFailAt < 60000;
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
  }

  // Warm every provider (combined mode uses them all) — primary a bit deeper than the rest.
  warm(n = 4) { this.providers.forEach((p, i) => p.warm(i === 0 ? n : Math.min(2, n))); }

  // COMBINED multi-provider mode: each article goes to the least-loaded healthy provider, so
  // several accounts add up instead of idling as failover. Load = (active + queued) / size.
  // The sort is stable: while the primary keeps up (load 0) the configured order wins — extra
  // providers only pull work once earlier ones saturate, and a circuit-broken provider sinks
  // to the back but is still tried last (a wrong breaker can never lose an article).
  _ordered() {
    if (this.providers.length === 1) return this.providers;
    const load = (p) => p.down() ? Infinity : (p.busy.size + p.queue.length) / Math.max(1, p.size);
    return [...this.providers].sort((a, b) => load(a) - load(b));
  }

  // True if ANY provider has the article.
  async stat(msgId) {
    for (const p of this._ordered()) {
      try { if (await p.stat(msgId)) return true; } catch { /* provider down → try next */ }
    }
    return false;
  }

  async body(msgId) {
    let lastErr;
    for (const p of this._ordered()) {
      try { return await p.body(msgId); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  run(fn) { return this._ordered()[0].run(fn); }
  close() { for (const p of this.providers) p.close(); }
}

module.exports = { NntpConnection, NntpPool, ProviderPool };
