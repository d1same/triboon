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

test('Amazon Fire TV build: amazonRelease strips self-update and Google Cast without altering direct/Play builds', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /buildConfigField "boolean", "AMAZON_DISTRIBUTION", "false"/);
  assert.match(gradle, /amazonRelease\s*\{[\s\S]*initWith release[\s\S]*buildConfigField "boolean", "AMAZON_DISTRIBUTION", "true"/);
  assert.match(gradle, /assembleAmazonRelease/);

  const amazonManifest = read('android/app/src/amazonRelease/AndroidManifest.xml');
  assert.match(amazonManifest, /android\.permission\.REQUEST_INSTALL_PACKAGES[\s\S]*tools:node="remove"/);
  assert.match(amazonManifest, /com\.google\.android\.gms\.cast\.framework\.OPTIONS_PROVIDER_CLASS_NAME[\s\S]*tools:node="remove"/);
  assert.match(amazonManifest, /androidx\.core\.content\.FileProvider[\s\S]*tools:node="remove"/);
});

test('Amazon Fire TV shell: MainActivity and web UI disable GMS Cast and route updates through Amazon Appstore', () => {
  const java = read('android/app/src/main/java/app/triboon/tv/MainActivity.java');
  assert.match(java, /BuildConfig\.AMAZON_DISTRIBUTION \? "amazon" :/);
  assert.match(java, /private void openAmazonAppstoreListing\(\)/);
  assert.match(java, /amzn:\/\/apps\/android\?p=/);
  assert.match(java, /if \(BuildConfig\.AMAZON_DISTRIBUTION\)\s*\{\s*openAmazonAppstoreListing\(\);\s*return;\s*\}/);
  assert.match(java, /if \(BuildConfig\.AMAZON_DISTRIBUTION\)\s*\{\s*castUnavailable = true;\s*return null;\s*\}/);

  const html = read('web/index.html');
  assert.match(html, /function isAmazonStoreAndroidShell\(\)/);
  assert.match(html, /ver\.distribution === 'amazon'/);
  assert.match(html, /Triboon updates automatically through the Amazon Appstore\./);
});

test('Amazon Appstore listing assets and CI workflow match Fire TV requirements', () => {
  assert.deepStrictEqual(pngSize('android/amazon-store/icon-512.png'), { width: 512, height: 512 });
  assert.deepStrictEqual(pngSize('android/amazon-store/icon-114.png'), { width: 114, height: 114 });
  assert.deepStrictEqual(pngSize('android/amazon-store/promo-1024x500.png'), { width: 1024, height: 500 });
  assert.deepStrictEqual(pngSize('android/amazon-store/firetv-background-1920x1080.png'), { width: 1920, height: 1080 });
  assert.ok(fs.existsSync(path.join(root, 'android/amazon-store/AMAZON_STORE_LISTING.md')));
  const wf = read('.github/workflows/amazon.yml');
  assert.match(wf, /lintAmazonRelease assembleAmazonRelease/);
  assert.match(wf, /OPTIONS_PROVIDER_CLASS_NAME/);
  const usesRefs = [...wf.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)].map((m) => m[1]);
  assert.ok(usesRefs.length > 0);
  for (const ref of usesRefs) {
    assert.ok(/@[0-9a-f]{40}$/.test(ref), `amazon.yml action pinned by full SHA: ${ref}`);
  }
});
