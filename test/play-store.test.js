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

test('Google Play Android build: playRelease strips REQUEST_INSTALL_PACKAGES without altering direct release APK', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /buildConfigField "boolean", "PLAY_DISTRIBUTION", "false"/);
  assert.match(gradle, /playRelease\s*\{[\s\S]*initWith release[\s\S]*buildConfigField "boolean", "PLAY_DISTRIBUTION", "true"/);
  assert.match(gradle, /bundlePlayRelease/);

  const playManifest = read('android/app/src/playRelease/AndroidManifest.xml');
  assert.match(playManifest, /android\.permission\.REQUEST_INSTALL_PACKAGES[\s\S]*tools:node="remove"/);
  assert.match(playManifest, /androidx\.core\.content\.FileProvider[\s\S]*tools:node="remove"/);

  const mainManifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(mainManifest, /android\.software\.leanback" android:required="false"/);
  assert.match(mainManifest, /android\.hardware\.touchscreen" android:required="false"/);
  assert.match(mainManifest, /android\.intent\.category\.LEANBACK_LAUNCHER/);
  assert.match(mainManifest, /android\.intent\.category\.LAUNCHER/);
  assert.match(mainManifest, /android:resizeableActivity="true"/);
});

test('Google Play Android shell: MainActivity and web UI route Play builds through Google Play updates', () => {
  const java = read('android/app/src/main/java/app/triboon/tv/MainActivity.java');
  assert.match(java, /BuildConfig\.PLAY_DISTRIBUTION \? "play" : "direct"/);
  assert.match(java, /private void openPlayStoreListing\(\)/);
  assert.match(java, /if \(BuildConfig\.PLAY_DISTRIBUTION\)\s*\{\s*openPlayStoreListing\(\);\s*return;\s*\}/);

  const html = read('web/index.html');
  assert.match(html, /function isPlayStoreAndroidShell\(\)/);
  assert.match(html, /ver\.distribution === 'play'/);
  assert.match(html, /Triboon updates automatically through Google Play\./);
});

test('Google Play listing assets and privacy policy match Play Console dimensions', () => {
  assert.deepStrictEqual(pngSize('android/play-store/icon-512.png'), { width: 512, height: 512 });
  assert.deepStrictEqual(pngSize('android/play-store/feature-graphic-1024x500.png'), { width: 1024, height: 500 });
  assert.deepStrictEqual(pngSize('android/play-store/tv-banner-1280x720.png'), { width: 1280, height: 720 });
  assert.ok(fs.existsSync(path.join(root, 'PRIVACY.md')), 'PRIVACY.md exists');
  assert.ok(fs.existsSync(path.join(root, 'android/play-store/PLAY_STORE_LISTING.md')), 'Play Console listing guide exists');
  assert.ok(fs.existsSync(path.join(root, '.github/workflows/play.yml')), 'Play Store AAB workflow exists');
});
