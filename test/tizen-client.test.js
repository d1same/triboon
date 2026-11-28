'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const urlHelper = require('../clients/tizen/server-url.js');

function pngSize(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${rel} should be a valid PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('Samsung Tizen: server URL normalization and validation reject unsafe schemes and build tizen launch URL', () => {
  assert.strictEqual(urlHelper.normalizeServerUrl('http://192.168.1.50:7777/'), 'http://192.168.1.50:7777');
  assert.strictEqual(urlHelper.normalizeServerUrl('192.168.1.50:7777'), 'http://192.168.1.50:7777');
  assert.strictEqual(urlHelper.normalizeServerUrl('https://tv.example.com/foo'), 'https://tv.example.com');
  assert.strictEqual(urlHelper.normalizeServerUrl('javascript:alert(1)'), '');
  assert.strictEqual(urlHelper.normalizeServerUrl('file:///etc/passwd'), '');
  assert.strictEqual(urlHelper.normalizeServerUrl('http://user:pass@192.168.1.50:7777'), '');
  assert.strictEqual(urlHelper.buildServerLaunchUrl('https://tv.example.com'), 'https://tv.example.com/?triboon_client=tizen');
  assert.strictEqual(urlHelper.isValidTriboonServerPayload({ app: 'triboon', version: '3.6.1' }), true);
  assert.strictEqual(urlHelper.isValidTriboonServerPayload({ version: '3.6.1' }), true);
  assert.strictEqual(urlHelper.isValidTriboonServerPayload({}), false);
});

test('Samsung Tizen: config.xml aligns with package.json and artwork matches Tizen TV requirements', () => {
  const pkg = JSON.parse(read('package.json'));
  const cfg = read('clients/tizen/config.xml');
  assert.match(cfg, new RegExp(`version="${pkg.version.replace(/\./g, '\\.')}"`));
  assert.match(cfg, /<tizen:profile name="tv-samsung"\/>/);
  assert.match(cfg, /http:\/\/tizen\.org\/privilege\/internet/);
  assert.match(cfg, /http:\/\/tizen\.org\/privilege\/tv\.inputdevice/);
  assert.match(cfg, /<access origin="\*" subdomains="true"\/>/);
  assert.deepStrictEqual(pngSize('clients/tizen/icon-512.png'), { width: 512, height: 512 });
  assert.deepStrictEqual(pngSize('clients/tizen/splash-1920x1080.png'), { width: 1920, height: 1080 });
});

test('Samsung Tizen: connect shell and web/index.html wire Return (10009), remote keys, DTS cap, and store update copy', () => {
  const connectJs = read('clients/tizen/connect.js');
  const indexHtml = read('clients/tizen/index.html');
  const webHtml = read('web/index.html');
  assert.match(connectJs, /10009/);
  assert.match(connectJs, /getCurrentApplication\(\)\.exit\(\)/);
  assert.match(connectJs, /tvinputdevice/);
  assert.match(indexHtml, /Triboon for Samsung TV/);
  assert.match(webHtml, /function initTizenShell\(\)/);
  assert.match(webHtml, /triboon_client'\) === 'tizen'/);
  assert.match(webHtml, /code === 10009/);
  assert.match(webHtml, /dts:\s*\(iosSafari \|\| webosTv \|\| tizenTv\)/);
  assert.match(webHtml, /Triboon for Samsung TV updates through Samsung Apps\./);
});

test('Samsung Tizen: store listing guide and pinned GitHub Actions workflow exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'clients/tizen/TIZEN_STORE_LISTING.md')));
  const wf = read('.github/workflows/tizen.yml');
  assert.match(wf, /Triboon-Samsung-Tizen-v\$\{ver\}\.wgt/);
  const usesRefs = [...wf.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)].map((m) => m[1]);
  assert.ok(usesRefs.length > 0);
  for (const ref of usesRefs) {
    assert.ok(/@[0-9a-f]{40}$/.test(ref), `tizen.yml action pinned by full SHA: ${ref}`);
  }
});
