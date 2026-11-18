'use strict';

// A paused player holds its connection and stops reading (brief 104). The legacy local-library stream
// route /api/local/:lib/:idx kept the server's idle socket timeout, so any pause longer than it
// ended the stream: the player got its last buffered bytes and then the end. The test shortens the
// server's timeout (30 s in production) so a 3 s pause shows the same thing. Every name is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { httpJson, bootServer, setupAdmin } = require('./helpers');

const SIZE = 32 << 20;

async function scanAndWait(port, id, admin) {
  await httpJson(port, 'POST', `/api/libraries/${id}/scan`, {}, admin);
  for (let i = 0; i < 200; i++) {
    const st = await httpJson(port, 'GET', `/api/libraries/${id}/scanstatus`, null, admin);
    if (!st.json.running) return st.json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('scan did not finish');
}

test('a paused player holding the legacy local stream gets the rest of the file after the pause', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-pause-'));
  fs.mkdirSync(path.join(root, 'Quiet Lake (2004)'));
  fs.writeFileSync(path.join(root, 'Quiet Lake (2004)', 'Quiet Lake.mkv'), crypto.randomBytes(SIZE));
  const srv = await bootServer({ TMDB_BASE: null });
  const oldTimeout = srv.server.timeout;
  let req = null;
  try {
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Pause', kind: 'movie', path: root }, admin);
    const id = created.json.id;
    await scanAndWait(srv.port, id, admin);
    const items = (await httpJson(srv.port, 'GET', `/api/libraries/${id}/items?limit=10`, null, admin)).json.items || [];
    const film = items.find((x) => x.streamUrl);
    assert.ok(film, 'the film has a stream URL');
    srv.server.timeout = 1500; // production: 30 s
    const res = await new Promise((ok, no) => {
      req = http.get(`http://127.0.0.1:${srv.port}${film.streamUrl}`, ok);
      req.on('error', no);
    });
    assert.strictEqual(res.statusCode, 200);
    let got = 0;
    let errored = false;
    res.on('error', () => { errored = true; });
    await new Promise((ok) => { res.on('data', function first(c) { got += c.length; if (got >= (2 << 20)) { res.removeListener('data', first); res.pause(); ok(); } }); });
    await new Promise((r) => setTimeout(r, 3000)); // the pause: the socket is held, nothing is read
    const done = await new Promise((ok) => {
      const to = setTimeout(() => ok('timeout'), 15000);
      res.on('data', (c) => { got += c.length; });
      res.on('end', () => { clearTimeout(to); ok('end'); });
      res.on('close', () => { clearTimeout(to); ok('close'); });
      res.resume();
    });
    assert.ok(!errored && got === SIZE, `after the pause the whole file arrives (${got} of ${SIZE} bytes, ${done})`);
  } finally {
    srv.server.timeout = oldTimeout;
    try { req && req.destroy(); } catch {}
    await srv.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
