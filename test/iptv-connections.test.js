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
// With `hls`, one more channel (index N) is an HLS playlist that a TV app polls.
function startProvider({ channels = 3, garbage = -1, hls = false } = {}) {
  const state = { active: 0, peak: 0, total: 0, opens: {}, hlsPolls: 0, delayMs: {}, delayOnce: {}, timers: new Set() };
  const playlist = ['#EXTM3U'];
  for (let i = 0; i < channels; i++) {
    playlist.push(`#EXTINF:-1 group-title="Test",Conn ${i}`);
    playlist.push(`http://127.0.0.1:PORT/live/${i}.ts`);
  }
  if (hls) {
    playlist.push('#EXTINF:-1 group-title="Test",Conn HLS');
    playlist.push('http://127.0.0.1:PORT/hls/live.m3u8');
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/list.m3u') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(playlist.join('\n').replaceAll('PORT', String(server.address().port)));
    }
    if (req.url.startsWith('/hls/live.m3u8')) {
      state.hlsPolls++;
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2.0,\nseg1.ts\n');
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

test('live: a stop on one screen and a different channel on another screen of the same user hold one connection (P1-1)', async () => {
  const provider = await startProvider({ channels: 3 });
  let rig = null;
  const clients = [];
  try {
    rig = await bootWithSource(provider);
    const [c0, c1] = rig.channels;
    // The TV plays channel 0, then stops (the app drops the request: the hub lingers 12 s).
    const tv = await open(rig.srv.port, withSurface(c0.nativeUrl, 'tv'), TV_UA);
    clients.push(tv);
    assert.ok(await waitFor(() => tv.bytes > 0), 'the TV plays');
    drop(tv);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(provider.state.active, 1, 'the stopped channel lingers (same-channel rejoin)');
    provider.resetPeak();
    // The same user opens a DIFFERENT channel on another screen (a Multiview pane, another app).
    const pane = await open(rig.srv.port, withSurface(c1.nativeUrl, 'mv0'), CHROME_UA);
    clients.push(pane);
    assert.ok(await waitFor(() => pane.bytes > 0), 'the other screen plays');
    assert.ok(await waitFor(() => provider.state.active === 1, 2000),
      `the lingering channel closed when the same user opened another channel (active ${provider.state.active})`);
    assert.strictEqual(provider.state.peak, 1, `never two provider connections (peak ${provider.state.peak})`);
    // The same channel still rejoins instantly from another screen (no new provider connection).
    const before = provider.state.total;
    const again = await open(rig.srv.port, withSurface(c1.nativeUrl, 'tv'), TV_UA);
    clients.push(again);
    assert.ok(await waitFor(() => again.bytes > 0), 'a second screen on the same channel plays');
    assert.strictEqual(provider.state.total, before, 'it joined the live upstream');
  } finally {
    clients.forEach(drop);
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});

test('live: Max connections = 1 stops the oldest stream for a new one, tells the stopped viewer why, and never ping-pongs (P1-2)', async () => {
  const provider = await startProvider({ channels: 3 });
  let rig = null;
  const clients = [];
  try {
    rig = await bootWithSource(provider, { maxConnections: 1 });
    const [c0, c1, c2] = rig.channels;
    const tv = await open(rig.srv.port, withSurface(c0.nativeUrl, 'tv'), TV_UA);
    clients.push(tv);
    assert.ok(await waitFor(() => tv.bytes > 0), 'the first screen plays');
    provider.resetPeak();
    // A second screen opens another channel: the oldest stream (the TV) is stopped first.
    const pane = await open(rig.srv.port, withSurface(c1.nativeUrl, 'mv1'), TV_UA);
    clients.push(pane);
    assert.ok(await waitFor(() => pane.bytes > 0, 3000), `the new screen plays (status ${pane.status})`);
    assert.ok(await waitFor(() => tv.ended, 2000), 'the oldest stream was stopped');
    assert.strictEqual(provider.state.peak, 1, `never two provider connections (peak ${provider.state.peak})`);
    // The stopped screen's player asks again: it gets the reason, and the other screen keeps playing.
    const retry = await open(rig.srv.port, withSurface(c0.nativeUrl, 'tv'), TV_UA);
    clients.push(retry);
    assert.strictEqual(retry.status, 429);
    assert.match(retry.error, /This channel was stopped because the provider allows 1 connection$/);
    const before = pane.bytes;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!pane.ended && pane.bytes > before, 'the newer screen is not stopped by the retry');
    assert.strictEqual(provider.state.active, 1);
    // A zap on the same screen does not count twice: the old channel closes, the new one opens.
    const zap = await open(rig.srv.port, withSurface(c2.nativeUrl, 'mv1'), TV_UA);
    clients.push(zap);
    assert.ok(await waitFor(() => zap.bytes > 0, 3000), `the zap plays (status ${zap.status})`);
    assert.strictEqual(provider.state.peak, 1, `a zap never holds two (peak ${provider.state.peak})`);
    // Only the stopped screen's retries are held back: a different screen (a new Multiview pane)
    // is a deliberate open and stops the oldest stream as usual, also right after a stop.
    const third = await open(rig.srv.port, withSurface(c0.nativeUrl, 'mv2'), TV_UA);
    clients.push(third);
    assert.ok(await waitFor(() => third.bytes > 0, 3000), `a new screen plays (status ${third.status} ${third.error})`);
    assert.ok(await waitFor(() => zap.ended, 2000), 'the oldest stream (the zapped pane) was stopped');
    assert.strictEqual(provider.state.peak, 1, `still never two (peak ${provider.state.peak})`);
  } finally {
    clients.forEach(drop);
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});

test('live: with no Max connections set, two screens keep two streams (unchanged behaviour)', async () => {
  const provider = await startProvider({ channels: 2 });
  let rig = null;
  const clients = [];
  try {
    rig = await bootWithSource(provider);
    const [c0, c1] = rig.channels;
    const a = await open(rig.srv.port, withSurface(c0.nativeUrl, 'tv'), TV_UA);
    const b = await open(rig.srv.port, withSurface(c1.nativeUrl, 'mv1'), TV_UA);
    clients.push(a, b);
    assert.ok(await waitFor(() => a.bytes > 0 && b.bytes > 0), 'both play');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!a.ended, 'the first stream is not stopped');
    assert.strictEqual(provider.state.active, 2);
  } finally {
    clients.forEach(drop);
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});

test('live: Max connections is a source setting (1 to 10 or empty), and changing it alone keeps the channel list', async () => {
  const provider = await startProvider({ channels: 2 });
  let rig = null;
  try {
    rig = await bootWithSource(provider);
    const id = rig.sourceId;
    const set = async (v) => httpJson(rig.srv.port, 'PATCH', `/api/iptv/sources/${id}`, { maxConnections: v }, rig.admin);
    const get = async () => (await httpJson(rig.srv.port, 'GET', '/api/iptv/sources', null, rig.admin)).json.sources.find((s) => s.id === id);
    assert.strictEqual((await get()).maxConnections, null, 'empty by default (no limit)');
    const statusBefore = (await httpJson(rig.srv.port, 'GET', '/api/iptv/status', null, rig.admin)).json;
    const cachedAt = (statusBefore.sources || []).find((s) => s.sourceId === id).channelCachedAt;
    assert.strictEqual((await set(3)).status, 200);
    assert.strictEqual((await get()).maxConnections, 3);
    const statusAfter = (await httpJson(rig.srv.port, 'GET', '/api/iptv/status', null, rig.admin)).json;
    assert.strictEqual((statusAfter.sources || []).find((s) => s.sourceId === id).channelCachedAt, cachedAt,
      'changing only the limit does not reload the channels');
    await set(0); assert.strictEqual((await get()).maxConnections, null, '0 means no limit');
    await set(11); assert.strictEqual((await get()).maxConnections, null, 'out of range means no limit');
    await set('2'); assert.strictEqual((await get()).maxConnections, 2);
    await set(''); assert.strictEqual((await get()).maxConnections, null, 'cleared');
    const viewer = await httpJson(rig.srv.port, 'GET', '/api/iptv/sources', null, null);
    assert.strictEqual(viewer.status, 401, 'the source list (with its limit) stays admin-only');
  } finally {
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});

test('web: the Live TV source editor has a Max connections field that is saved, shown on edit and cleared', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /<input id="iptvMaxConn" type="number" min="1" max="10"/, 'the field is in the source form');
  // A saved limit fills the box, so the placeholder alone would leave a bare number: it carries the
  // same visible label as the other number settings (Graphite settingsControl).
  assert.match(ui, /<label class="settingsControl"[^>]*><span>Max connections<\/span><input id="iptvMaxConn"/, 'the field has a visible label');
  assert.match(ui, /maxConnections: \$\('iptvMaxConn'\)\.value\.trim\(\) \? parseInt\(\$\('iptvMaxConn'\)\.value, 10\) : null/, 'save sends it (empty = no limit)');
  assert.match(ui, /\$\('iptvMaxConn'\)\.value = src\.maxConnections \? String\(src\.maxConnections\) : ''/, 'editing a source shows its limit');
  assert.ok((ui.match(/'epgUrl', 'iptvMaxConn'\]/g) || []).length >= 3, 'every form reset clears it');
});

test('web: a live stream cut mid-play asks the server once why, and shows a Max connections reason', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /async function liveStopReason\(url\) \{[\s\S]+return \/provider allows\/i\.test\(reason\) \? reason : '';/,
    'only the limit reason is taken from the answer');
  assert.match(ui, /if \(!e\.liveProviderReason && appended > 0\) e\.liveStreamCut = true;/, 'a started stream that breaks is a cut');
  assert.match(ui, /if \(!split && e\.liveStreamCut && !e\.liveProviderReason && !e\.liveStopChecked\) \{/, 'asked once, main player and Multiview panes');
});

test('live: under Max connections an HLS playlist poll never stops another screen\'s stream (result 115 P1-1)', async () => {
  const provider = await startProvider({ channels: 2, hls: true });
  let rig = null;
  const clients = [];
  try {
    rig = await bootWithSource(provider, { maxConnections: 1 });
    const ts = rig.channels[0];
    const hlsCh = rig.channels.find((c) => /Conn HLS/.test(c.name));
    assert.ok(hlsCh, 'the HLS channel is listed');
    const tv = await open(rig.srv.port, withSurface(ts.nativeUrl, 'tv-a'), TV_UA);
    clients.push(tv);
    assert.ok(await waitFor(() => tv.bytes > 0), 'TV A plays the TS channel');
    // TV B polls the HLS channel's playlist, as ExoPlayer does, ten times.
    for (let i = 0; i < 10; i++) {
      const poll = await open(rig.srv.port, withSurface(hlsCh.nativeUrl, 'tv-b'), TV_UA);
      clients.push(poll);
      await waitFor(() => poll.ended, 2000);
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(provider.state.hlsPolls >= 10, `the playlist was served (${provider.state.hlsPolls})`);
    assert.ok(!tv.ended, 'TV A was never cut by a playlist poll');
    assert.strictEqual(provider.state.opens[0], 1, `the TS channel opened once (${provider.state.opens[0]})`);
  } finally {
    clients.forEach(drop);
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});

test('live: a stopped screen that keeps retrying stays stopped; the other screen is not taken back (result 115 P2-1)', async () => {
  const provider = await startProvider({ channels: 2 });
  let rig = null;
  const clients = [];
  try {
    rig = await bootWithSource(provider, { maxConnections: 1 });
    const [c0, c1] = rig.channels;
    const a = await open(rig.srv.port, withSurface(c0.nativeUrl, 'tv-a'), TV_UA);
    clients.push(a);
    assert.ok(await waitFor(() => a.bytes > 0), 'TV A plays');
    const b = await open(rig.srv.port, withSurface(c1.nativeUrl, 'tv-b'), TV_UA);
    clients.push(b);
    assert.ok(await waitFor(() => b.bytes > 0 && a.ended, 3000), 'TV B took the connection from TV A');
    // TV A's player retries every 3 s for 26 s, past the 20 s hold: every retry is refused
    // with the reason, and TV B keeps playing.
    const statuses = [];
    const until = Date.now() + 26000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      const retry = await open(rig.srv.port, withSurface(c0.nativeUrl, 'tv-a'), TV_UA);
      clients.push(retry);
      statuses.push(retry.status);
      if (retry.status === 200) break;
    }
    assert.ok(statuses.length >= 8 && statuses.every((s) => s === 429), `every retry was refused (${statuses.join(',')})`);
    assert.ok(!b.ended, 'TV B was never taken back');
    assert.strictEqual(provider.state.opens[1], 1, 'TV B\'s channel opened once');
  } finally {
    clients.forEach(drop);
    if (rig) await rig.srv.shutdown();
    provider.close();
  }
});
