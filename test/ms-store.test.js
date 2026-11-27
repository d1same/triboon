'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function pngSize(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${rel} should be a valid PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('Microsoft Store MSIX: packager embeds Partner Center identity and LGPL libmpv payload', () => {
  const script = read('clients/windows-px8/scripts/build-msix.ps1');
  assert.match(script, /Disame\.Triboon/);
  assert.match(script, /CN=CC350014-1964-4C3C-BCF7-6D4262F0EC93/);
  assert.match(script, /PublisherDisplayName = 'Disame'/);
  assert.match(script, /libmpv-2\.dll/);
  assert.match(script, /LIBMPV-LICENSE\.LGPL/);
  assert.match(script, /rescap:Capability Name="runFullTrust"/);
  assert.match(script, /privateNetworkClientServer/);
  assert.deepStrictEqual(pngSize('clients/windows-px8/ms-store/Wide310x150Logo.png'), { width: 310, height: 150 });
  assert.ok(fs.existsSync(path.join(root, '.github/workflows/ms-store.yml')));
  assert.ok(fs.existsSync(path.join(root, 'clients/windows-px8/ms-store/MS_STORE_LISTING.md')));
});

test('Microsoft Store Windows client: MSIX installs hide GitHub EXE updates while direct EXE stays unchanged', () => {
  const rust = read('clients/windows-px8/src-tauri/src/main.rs');
  assert.match(rust, /fn GetCurrentPackageFullName/);
  assert.match(rust, /"distribution": "msstore"/);
  assert.match(rust, /ms-windows-store:\/\/pdp\/\?ProductId=9N12LTV21B88/);

  const html = read('web/index.html');
  assert.match(html, /function isMicrosoftStoreWindowsShell\(\)/);
  assert.match(html, /ver\.distribution === 'msstore'/);
  assert.match(html, /Triboon updates automatically through the Microsoft Store\./);
});
