'use strict';
// Live TV provider connections (brief 113): a hub abandoned while starting, the browser TS-pipe
// fallback, the linger per user and source, and the per-source "Max connections" limit.
// A fake provider on 127.0.0.1 counts every stream socket. Every name here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { httpJson, bootServer, setupAdmin } = require('./helpers');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TV_UA = 'TriboonTV-test';

// A provider with N TS channels (ts bytes every 25 ms) and one garbage channel (index `garbage`).
function startProvider({ channels = 3, garbage = -1 } = {}) {
  const state = { active: 0, peak: 0, total: 0, opens: {}, delayMs: {}, delayOnce: {}, timers: new Set() };
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < channels; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Conn ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(server.address().port)));
    }
    const m = /^\/live\/(\d+)\.ts/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    const ch = Number(m[1]);
    state.active++; state.total++; state.peak = Math.max(state.peak, state.active);
    state.opens[ch] = (state.opens[ch] || 0) + 1;
    let closed = false;
    res.on('close', () => { if (!closed) { closed = true; state.active--; } });
    const go = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      const chunk = () => (ch === garbage ? Buffer.from('this is not a transport stream '.repeat(2100)) : Buffer.alloc(188 * 4, 0x47));
      res.write(chunk());
      const t = setInterval(() => { if (!res.destroyed) res.write(chunk()); }, 25);
      state.timers.add(t);
      res.on('close', () => { clearInterval(t); state.timers.delete(t); });
    };
    const delay = state.delayOnce[ch] || state.delayMs[ch] || 0;
    if (state.delayOnce[ch]) delete state.delayOnce[ch];
    if (delay) setTimeout(go, delay); else go();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, state, base: `http://127.0.0.1:${server.address().port}`,
    resetPeak() { state.peak = state.active; },
    close() { state.timers.forEach((t) => clearInterval(t)); server.closeAllConnections && server.closeAllConnections(); server.close(); },
  })));
}

const waitFor = async (fn, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return !!fn();
};
const withSurface = (u, s) => u + (u.includes('?') ? '&' : '?') + 'surface=' + s;
// Open a stream request; resolves on response headers (or on an error status).
const open = (port, p, ua = TV_UA) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': ua } }, (res) => {
    const out = { req, res, status: res.statusCode, error: res.headers['x-triboon-iptv-error'] || '', bytes: 0, ended: false };
    res.on('data', (c) => { out.bytes += c.length; });
    res.on('end', () => { out.ended = true; });
    res.on('close', () => { out.ended = true; });
    res.on('error', () => {});
    resolve(out);
  });
  req.on('error', reject);
});
// Open a stream request without waiting for headers (the server may hold it while starting).
const openPending = (port, p, ua = TV_UA) => {
  const out = { req: null, res: null, status: 0, error: '', bytes: 0, ended: false };
  out.req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'user-agent': ua } }, (res) => {
    out.res = res; out.status = res.statusCode; out.error = res.headers['x-triboon-iptv-error'] || '';
    res.on('data', (c) => { out.bytes += c.length; });
    res.on('end', () => { out.ended = true; });
    res.on('close', () => { out.ended = true; });
    res.on('error', () => {});
  });
  out.req.on('error', () => { out.ended = true; });
  return out;
};
const drop = (c) => { try { if (c.res) c.res.destroy(); } catch {} try { if (c.req) c.req.destroy(); } catch {} };

async function bootWithSource(provider, extraSource = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-iptv-conn-'));
  const srv = await bootServer({ TRIBOON_DATA: dataDir, NNTP_HOST: null, TMDB_BASE: null });
  const admin = await setupAdmin(srv.port);
  const created = await httpJson(srv.port, 'POST', '/api/iptv/sources',
    { name: 'Conn test', iptvMode: 'm3u', iptvUrl: `${provider.base}/list.m3u`, ...extraSource }, admin);
  assert.strictEqual(created.status, 200, JSON.stringify(created.json));
  let ch = null;
  for (let i = 0; i < 40; i++) {
    ch = await httpJson(srv.port, 'GET', '/api/iptv/channels', null, admin);
    if (ch.status === 200 && ch.json.channels && ch.json.channels.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ch && ch.json.channels && ch.json.channels.length, 'the channels load');
  return { srv, admin, dataDir, channels: ch.json.channels, sourceId: created.json.source.id };
}

test('live: a browser viewer that zaps away before the provider answers does not leave the channel dead (P1-3)', async () => {
  const provider = await startProvider({ channels: 2 });
  let rig = null;
  const clients = [];
  try {
    rig = await bootWithSource(provider);
    const ch0 = rig.channels[0];
    // The provider takes 2 s to answer the first open of channel 0; the browser viewer leaves after 0.3 s.
    provider.state.delayOnce[0] = 2000;
    const browser = openPending(rig.srv.port, withSurface(ch0.streamUrl, 'main'), CHROME_UA);
    clients.push(browser);
    await waitFor(() => provider.state.opens[0] === 1, 3000);
    await new Promise((r) => setTimeout(r, 300));
    drop(browser);
    await new Promise((r) => setTimeout(r, 200));
    // Another viewer opens the channel: it must play, not join a hub that can never start.
    const tv = openPending(rig.srv.port, withSurface(ch0.nativeUrl, 'tv'), TV_UA);
    clients.push(tv);
    assert.ok(await waitFor(() => tv.bytes > 0, 4000),
      `the channel plays again for the next viewer (status ${tv.status}, opens ${provider.state.opens[0]})`);
    // The abandoned open is gone at the provider; only the new viewer's stream is open.
    assert.ok(await waitFor(() => provider.state.active === 1, 3000), `one provider connection (active ${provider.state.active})`);
  } finally {
    clients.forEach(drop);
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});

test('live: when the browser TS pipe fails, the URL remux fallback runs and no upstream is held without a viewer (P2-1)', async () => {
  const provider = await startProvider({ channels: 2, garbage: 1 });
  let rig = null;
  const clients = [];
  try {
    rig = await bootWithSource(provider);
    const bad = rig.channels[1];
    const browser = openPending(rig.srv.port, withSurface(bad.streamUrl, 'main'), CHROME_UA);
    clients.push(browser);
    // The TS pipe opens the channel once; when ffmpeg gives up on the garbage, the URL remux
    // fallback must open it again (ffmpeg reads the URL itself) and the browser gets an answer.
    // ffmpeg keeps probing garbage until the 12 s startup timeout, then the fallback starts.
    assert.ok(await waitFor(() => (provider.state.opens[1] || 0) >= 2, 20000),
      `the URL remux fallback ran (opens ${provider.state.opens[1] || 0})`);
    assert.ok(await waitFor(() => browser.ended || browser.status >= 400, 40000),
      `the browser request ends (status ${browser.status})`);
    // Nothing lingers at the provider once the only viewer has its answer.
    assert.ok(await waitFor(() => provider.state.active === 0, 4000),
      `no upstream is held without a viewer (active ${provider.state.active})`);
  } finally {
    clients.forEach(drop);
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});
