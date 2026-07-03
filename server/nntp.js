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
// Hedged multi-provider failover (see docs-streaming-performance.md): if an active-player BODY
// hasn't answered within this window (queued behind other work, or a provider went slow AFTER the
// load-sort), speculatively start the NEXT provider too and take the first success — so one slow
// provider costs ~HEDGE_MS, not the full COMMAND_TIMEOUT_MS. Only active-player priorities hedge,
// so background/health/read-ahead never double-fetch.
const HEDGE_MS_DEFAULT = 3000;
const HEDGE_PRIORITIES = new Set(['startup', 'seek', 'playback']);

const MAX_NNTP_BODY_BYTES = 64 * 1024 * 1024; // one yEnc article should never be remotely this large

function abortError() {
  const e = new Error('NNTP command aborted');
  e.code = 'ABORT_ERR';
  return e;
}

function isAbortError(e) {
  return e && (e.code === 'ABORT_ERR' || e.name === 'AbortError');
}

function signalAborted(signal) {
  return !!(signal && signal.aborted);
}

function addAbortListener(signal, fn) {
  if (!signal || typeof signal.addEventListener !== 'function') return () => {};
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
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
      return this;
    }).catch((e) => { clearTimeout(this._connectTimer); throw e; });
  }

  _fail(err) {
    this.alive = false;
    clearTimeout(this._connectTimer);
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      if (typeof w.cleanupAbort === 'function') w.cleanupAbort();
      w.reject(err);
    }
    try { this.sock.destroy(); } catch {}
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    // Progress on the in-flight command (NNTP responses are strictly FIFO, so waiters[0] is the
    // one being answered): reset its stall timer so a slow-but-alive BODY transfer is never killed
    // mid-flight — only a genuinely wedged socket (no bytes at all for the window) trips it.
    if (d && d.length && this.waiters.length) this._armWaiterTimer(this.waiters[0]);
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
      () => this._fail(new Error(`NNTP stall timeout: ${w.cmdName}`)),
      this.opts.commandTimeoutMs || COMMAND_TIMEOUT_MS
    );
  }

  _cmd(line, multiline = false, opts = {}) {
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signalAborted(signal)) return reject(abortError());
      if (!this.sock || this.sock.destroyed) return reject(new Error('NNTP not connected'));
      const w = { resolve, reject, multiline, cmdName: line.split(' ')[0] };
      w.cleanupAbort = addAbortListener(signal, () => this._fail(abortError()));
      this._armWaiterTimer(w);
      this.waiters.push(w);
      this.lastUsed = Date.now();
      this.sock.write(line + '\r\n');
    });
  }

  async stat(msgId, opts = {}) {
    const r = await this._cmd(`STAT <${msgId.replace(/[<>]/g, '')}>`, false, opts);
    return r.status.startsWith('223');
  }

  async body(msgId, opts = {}) {
    const r = await this._cmd(`BODY <${msgId.replace(/[<>]/g, '')}>`, true, opts);
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
    this.queue = []; // pending tasks { fn, resolve, reject, priority }
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
    if (this.closed) return;
    if (this.down()) {
      // Half-open probe: the circuit breaker is open, but allow ONE throttled reconnect so a
      // provider that has actually recovered rejoins in seconds instead of waiting out the full
      // backoff. A live connection clears down(); a failed probe refreshes lastConnectFailAt and
      // keeps it open. Throttled so we never hammer a genuinely-dead host.
      const probeMs = this.opts.reconnectProbeMs || 8000;
      if (this.connecting > 0 || Date.now() - (this.lastProbeAt || 0) < probeMs) return;
      this.lastProbeAt = Date.now();
      target = 1;
    }
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
      if (!this.busy.has(c) && now - c.lastUsed > idleMs) { c.close(); return false; }
      return true;
    });
    if (this.queue.length && this.conns.length === 0 && this.connecting === 0 && this.down()) {
      this._ensure(); // give the breaker a throttled half-open probe before failing work over
      if (this.connecting > 0) return; // probing — its resolve (recovered) / reject (still down) re-pumps
      const q = this.queue; this.queue = [];
      const err = this.lastErr || new Error('provider temporarily unavailable');
      for (const t of q) { if (typeof t.cleanupAbort === 'function') t.cleanupAbort(); t.reject(err); }
      return;
    }
    if (this.queue.length && this.conns.length + this.connecting < this.size) this._ensure();
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
        if (idleFree <= reserve) break;
      }
      const task = this._shiftTask();
      if (!task) break;
      if (typeof task.cleanupAbort === 'function') task.cleanupAbort();
      this.busy.add(c);
      task.fn(c)
        .then(task.resolve, (e) => {
          // An NNTP status reply (e.code = '430' etc.) is a real answer — pass it through.
          // A connection-level failure (timeout/closed/reset) gets ONE retry on a fresh
          // connection so a single dead socket can't sink a whole mount.
          if (!isAbortError(e) && !task.retried && !/^\d{3}$/.test(String(e && e.code || ''))) {
            task.retried = true;
            this.queue.push(task);
          } else task.reject(e);
        })
        .finally(() => { this.busy.delete(c); this._pump(); });
    }
  }

  stat(msgId, priority = 'health', opts = {}) { return this.run((c) => c.stat(msgId, opts), priority, opts); }
  body(msgId, priority = 'playback', opts = {}) { return this.run((c) => c.body(msgId, opts), priority, opts); }
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
  async stat(msgId, priority = 'health', opts = {}) {
    let reachedAny = false; // did at least one provider actually ANSWER (vs. all connections failing)?
    for (const p of this._ordered()) {
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

  async body(msgId, priority = 'playback', opts = {}) {
    const ordered = this._ordered();
    if (!ordered.length) throw new Error('no usenet providers configured');
    // Plain sequential failover for single-provider setups and non-critical work (no speculative
    // double-fetch): a 430/connection error advances immediately to the next provider.
    if (ordered.length === 1 || !HEDGE_PRIORITIES.has(priority)) {
      let lastErr;
      for (const p of ordered) {
        try { return await p.body(msgId, priority, opts); } catch (e) { if (isAbortError(e)) throw e; lastErr = e; }
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
        hedgeTimer = setTimeout(() => { hedgeTimer = null; startNext(); }, hedgeMs);
        if (hedgeTimer && hedgeTimer.unref) hedgeTimer.unref();
      };
      const startNext = () => {
        if (settled || idx >= ordered.length) return;
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
    for (const p of this._ordered()) {
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
    };
  }
  close() { for (const p of this.providers) p.close(); }
}

module.exports = { NntpConnection, NntpPool, ProviderPool };
