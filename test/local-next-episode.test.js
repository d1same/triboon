'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, httpRaw, bootServer, setupAdmin } = require('./helpers');

async function runScan(port, libId, token) {
  const start = await httpJson(port, 'POST', `/api/libraries/${libId}/scan`, {}, token);
  assert.strictEqual(start.status, 202);
  for (let i = 0; i < 200; i++) {
    const st = await httpJson(port, 'GET', `/api/libraries/${libId}/scanstatus`, null, token);
    if (!st.json.running) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan timeout');
}

function nextInShowFolder(episodes, curS, curE) {
  const sorted = episodes.slice().sort((a, b) => a.s - b.s || a.e - b.e);
  const idx = sorted.findIndex((ep) => +ep.s === +curS && +ep.e === +curE);
  if (idx < 0 || idx >= sorted.length - 1) return null;
  return sorted[idx + 1];
}

test('local TV library: next episode is the following file in the same show folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-local-next-'));
  const sdir = path.join(root, 'IR Show (2025)');
  fs.mkdirSync(path.join(sdir, 'Season 01'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'tvshow.nfo'), '<tvshow><title>IR Show</title><year>2025</year></tvshow>');
  fs.writeFileSync(path.join(sdir, 'Season 01', 'IR Show - S01E01 - One.mp4'), 'EPISODE-ONE-BYTES');
  fs.writeFileSync(path.join(sdir, 'Season 01', 'IR Show - S01E02 - Two.mp4'), 'EPISODE-TWO-BYTES');

  const { port, shutdown } = await bootServer();
  const admin = await setupAdmin(port);
  try {
    const lib = await httpJson(port, 'POST', '/api/libraries', { name: 'IR TV Shows', kind: 'movie', path: root }, admin);
    assert.strictEqual(lib.status, 200);
    await runScan(port, lib.json.id, admin);

    const show = (await httpJson(port, 'GET', `/api/libraries/${lib.json.id}/items`, null, admin)).json.items
      .find((i) => i.kind === 'show');
    assert.ok(show);

    const epsPage = (await httpJson(
      port, 'GET',
      `/api/libraries/${lib.json.id}/items?showIdx=${show.idx}&limit=50&offset=0`,
      null, admin,
    )).json;
    const episodes = (epsPage.items || []).filter((x) => x.kind === 'episode');
    assert.strictEqual(episodes.length, 2);

    const ep1 = episodes.find((e) => e.s === 1 && e.e === 1);
    const ep2 = nextInShowFolder(episodes, 1, 1);
    assert.ok(ep2 && ep2.e === 2, 'folder order picks S01E02 after S01E01');

    const body1 = (await httpRaw(port, ep1.streamUrl, { token: admin })).body.toString();
    const body2 = (await httpRaw(port, ep2.streamUrl, { token: admin })).body.toString();
    assert.strictEqual(body1, 'EPISODE-ONE-BYTES');
    assert.strictEqual(body2, 'EPISODE-TWO-BYTES');

    const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    assert.match(ui, /async function prepLocalLibraryNextEpisode\(it, token, current\)/,
      'browser Up Next uses local-folder next episode');
    assert.match(ui, /async function prepLocalPlayerSeasonEpisodes\(it\)/,
      'browser player episode rail uses local folder episodes');
  } finally {
    await shutdown();
  }
});
