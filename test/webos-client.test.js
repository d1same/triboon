'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const webosUrl = require('../clients/webos/server-url.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function pngSize(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${rel} should be a valid PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('LG webOS client: appinfo.json matches package.json version and enforces TV Back/splash compliance', () => {
  const pkg = JSON.parse(read('package.json'));
  const info = JSON.parse(read('clients/webos/appinfo.json'));
  assert.strictEqual(info.id, 'app.triboon.webos');
  assert.strictEqual(info.version, pkg.version, 'webOS appinfo.json version matches package.json');
  assert.strictEqual(info.type, 'web');
  assert.strictEqual(info.main, 'index.html');
  assert.strictEqual(info.resolution, '1920x1080');
  assert.strictEqual(info.disableBackHistoryAPI, true, 'LG Back key (461) must route to JS instead of browser history');
  assert.strictEqual(info.bgColor, '#0b0b0f');

  assert.deepStrictEqual(pngSize('clients/webos/icon-80.png'), { width: 80, height: 80 });
  assert.deepStrictEqual(pngSize('clients/webos/icon-130.png'), { width: 130, height: 130 });
  assert.deepStrictEqual(pngSize('clients/webos/store-icon-400.png'), { width: 400, height: 400 });
  assert.deepStrictEqual(pngSize('clients/webos/splash-1920x1080.png'), { width: 1920, height: 1080 });
  assert.ok(fs.existsSync(path.join(root, 'clients/webos/WEBOS_STORE_LISTING.md')));
});

test('LG webOS client: server-url helper validates origins, blocks unsafe schemes, and builds launch URLs', () => {
  assert.strictEqual(webosUrl.normalizeServerUrl('192.168.1.50:7777'), 'http://192.168.1.50:7777');
  assert.strictEqual(webosUrl.normalizeServerUrl('https://tv.example.com/some/path?x=1'), 'https://tv.example.com');
  assert.strictEqual(webosUrl.normalizeServerUrl('javascript:alert(1)'), '');
  assert.strictEqual(webosUrl.normalizeServerUrl('file:///etc/passwd'), '');
  assert.strictEqual(webosUrl.normalizeServerUrl('http://user:pass@192.168.1.50:7777'), '');
  assert.strictEqual(webosUrl.buildServerLaunchUrl('https://tv.example.com/'), 'https://tv.example.com/?triboon_client=webos');
  assert.strictEqual(webosUrl.isValidTriboonServerPayload({ app: 'triboon', version: '3.5.14' }), true);
  assert.strictEqual(webosUrl.isValidTriboonServerPayload({ name: 'Triboon' }), true);
  assert.strictEqual(webosUrl.isValidTriboonServerPayload({ version: '3.5.14' }), true);
  assert.strictEqual(webosUrl.isValidTriboonServerPayload({ hello: 'world' }), false);
});

test('LG webOS client: web/index.html wires TV mode, LG Back/media keys, DTS cap, and LG Store update copy', () => {
  const html = read('web/index.html');
  assert.match(html, /function initWebOSShell\(\)/);
  assert.match(html, /triboon_client.*webos/);
  assert.match(html, /code === 461/);
  assert.match(html, /window\.webOS\.platformBack/);
  assert.match(html, /dts:\s*\(iosSafari \|\| webosTv\) \? false/);
  assert.match(html, /function isWebOSTVShell\(\)/);
  assert.match(html, /Triboon for LG TV updates through the LG Content Store\./);

  const wf = read('.github/workflows/webos.yml');
  assert.match(wf, /ares-package/);
  assert.match(wf, /triboon-webos-manifest\.json/);
  const usesRefs = [...wf.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)].map((m) => m[1]);
  assert.ok(usesRefs.length > 0);
  for (const ref of usesRefs) {
    assert.ok(/@[0-9a-f]{40}$/.test(ref), `webos.yml action pinned by full SHA: ${ref}`);
  }
});
