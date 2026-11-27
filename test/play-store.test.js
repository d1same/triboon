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
  assert.ok(fs.existsSync(path.join(root, 'android/play-store/upload-play.js')), 'Google Play auto-upload script exists');
});

test('Google Play CI auto-publish: play.yml runs signed AAB + Play upload on v* tags and workflow_dispatch', () => {
  const wf = read('.github/workflows/play.yml');
  assert.match(wf, /tags:\s*\['v\*'\]/);
  assert.match(wf, /startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
  assert.match(wf, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
  assert.match(wf, /node android\/play-store\/upload-play\.js/);
});

test('Google Play auto-upload helper: parses raw/base64 service account, signs RS256 JWT, and detects draft app fallback', () => {
  const crypto = require('node:crypto');
  const uploader = require('../android/play-store/upload-play.js');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const sample = { client_email: 'ci@example.iam.gserviceaccount.com', private_key: privateKey };
  const raw = JSON.stringify(sample);
  const b64 = Buffer.from(raw, 'utf8').toString('base64');

  assert.strictEqual(uploader.parseServiceAccountJson(raw).client_email, sample.client_email);
  assert.strictEqual(uploader.parseServiceAccountJson(b64).client_email, sample.client_email);

  const jwt = uploader.buildJwtAssertion(sample, 1700000000);
  const parts = jwt.split('.');
  assert.strictEqual(parts.length, 3);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const sigBuf = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.strictEqual(verifier.verify(publicKey, sigBuf), true, 'JWT RS256 signature must verify');

  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.strictEqual(payload.iss, sample.client_email);
  assert.strictEqual(payload.scope, 'https://www.googleapis.com/auth/androidpublisher');
  assert.strictEqual(payload.iat, 1700000000);
  assert.strictEqual(payload.exp, 1700003600);

  assert.strictEqual(uploader.isDraftAppError(400, 'Only releases with status draft may be created on draft app.'), true);
  assert.strictEqual(uploader.isDraftAppError(403, 'Version code 461 has already been used.'), false);

  const body = uploader.buildTrackReleaseBody({
    track: 'internal',
    versionCode: 461,
    status: 'completed',
    releaseName: '3.6.1 (461)',
    notes: 'Triboon v3.6.1',
  });
  assert.deepStrictEqual(body, {
    track: 'internal',
    releases: [{
      name: '3.6.1 (461)',
      versionCodes: ['461'],
      status: 'completed',
      releaseNotes: [{ language: 'en-US', text: 'Triboon v3.6.1' }],
    }],
  });
});
