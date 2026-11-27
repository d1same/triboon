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

test('Microsoft Store CI auto-publish: ms-store.yml builds on v* tags, pins actions by SHA, and wires Partner Center API uploader', () => {
  const wf = read('.github/workflows/ms-store.yml');
  assert.match(wf, /tags:\s*\['v\*'\]/);
  assert.match(wf, /startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
  assert.match(wf, /MS_STORE_TENANT_ID/);
  assert.match(wf, /MS_STORE_CLIENT_ID/);
  assert.match(wf, /MS_STORE_CLIENT_SECRET/);
  assert.match(wf, /node clients\/windows-px8\/scripts\/upload-ms-store\.js/);
  const usesRefs = [...wf.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)].map((m) => m[1]);
  assert.ok(usesRefs.length > 0);
  for (const ref of usesRefs) {
    assert.ok(/@[0-9a-f]{40}$/.test(ref), `ms-store.yml action pinned by full SHA: ${ref}`);
  }
});

test('Microsoft Store API uploader: builds Entra token params, marks old packages PendingDelete, and detects active certification states', () => {
  const uploader = require('../clients/windows-px8/scripts/upload-ms-store.js');
  const params = uploader.buildTokenParams({ clientId: 'cid-123', clientSecret: 'sec-456' });
  assert.strictEqual(params.get('grant_type'), 'client_credentials');
  assert.strictEqual(params.get('client_id'), 'cid-123');
  assert.strictEqual(params.get('client_secret'), 'sec-456');
  assert.strictEqual(params.get('resource'), 'https://manage.devcenter.microsoft.com');

  assert.strictEqual(uploader.isActiveCertificationState('Certification'), true);
  assert.strictEqual(uploader.isActiveCertificationState('PreProcessing'), true);
  assert.strictEqual(uploader.isActiveCertificationState('PendingCommit'), false);

  const next = uploader.prepareSubmissionPayload({
    id: 'sub-2',
    applicationPackages: [{ fileName: 'Triboon-Windows-Store-v3.5.14.msix', fileStatus: 'Uploaded' }],
  }, 'Triboon-Windows-Store-v3.6.1.msix');
  assert.strictEqual(next.applicationPackages.length, 2);
  assert.strictEqual(next.applicationPackages[0].fileStatus, 'PendingDelete');
  assert.deepStrictEqual(next.applicationPackages[1], {
    fileName: 'Triboon-Windows-Store-v3.6.1.msix',
    fileStatus: 'PendingUpload',
  });
});
