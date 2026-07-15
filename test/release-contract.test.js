'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('release contract: package, Android, and CI tag versions agree', () => {
  const pkg = JSON.parse(read('package.json'));
  const gradle = read('android/app/build.gradle');
  const versionName = /versionName\s*=\s*"([^"]+)"/.exec(gradle);
  const versionCode = /versionCode\s*=\s*(\d+)/.exec(gradle);
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package version is semver: ${pkg.version}`);
  assert.strictEqual(versionName && versionName[1], pkg.version, 'Android versionName matches package.json');
  assert.ok(versionCode && Number(versionCode[1]) > 0, 'Android versionCode is a positive integer');
  const ref = process.env.GITHUB_REF_NAME || '';
  const tagEvent = process.env.GITHUB_REF_TYPE === 'tag' || String(process.env.GITHUB_REF || '').startsWith('refs/tags/');
  if (tagEvent) {
    assert.match(ref, /^v\d+\.\d+\.\d+$/, 'release events require a strict semver tag');
    assert.strictEqual(ref, `v${pkg.version}`, 'tag matches the app version');
  }
});

test('release contract: every package verification/release entrypoint exists in the clone', () => {
  const pkg = JSON.parse(read('package.json'));
  const required = [
    ['verify:full', 'bench/verify-before-update.ps1'],
    ['verify:live', 'bench/verify-live.js'],
    ['release:apk', 'bench/cut-apk-release.ps1'],
    ['Android stress', 'bench/android-tv-stress.ps1'],
    ['Android smoke', 'bench/android-tv-smoke.ps1'],
    ['Android testing guide', 'docs-android-tv-testing.md'],
    ['release contract', 'test/release-contract.test.js'],
    ['license', 'LICENSE'],
    ['third-party notices', 'THIRD-PARTY-NOTICES.md'],
    ['Windows dependency lock', 'installer/windows/dependencies.lock.json'],
    ['Windows compiler bootstrap', 'installer/windows/install-inno.ps1'],
  ];
  for (const [name, rel] of required) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${name} entrypoint is tracked: ${rel}`);
    if (fs.existsSync(path.join(root, '.git'))) {
      assert.doesNotThrow(() => execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, stdio: 'ignore' }),
        `${name} must be in the git index, not merely present locally: ${rel}`);
    }
  }
  assert.match(pkg.scripts.test, /^node --test --test-force-exit /,
    'npm test runs the Node test runner with forced process cleanup');
  assert.match(pkg.scripts.test, /--test-concurrency=1/,
    'top-level suites run sequentially because several integration suites own process-wide fetch/env state');
  const listedTests = [...pkg.scripts.test.matchAll(/test\/[^\s]+\.test\.js/g)].map((match) => match[0]).sort();
  const expectedTests = fs.readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `test/${name}`)
    .sort();
  assert.deepStrictEqual(listedTests, expectedTests,
    'npm test explicitly lists every top-level test suite and cannot auto-run fixture generators');
  assert.doesNotMatch(pkg.scripts.test, /gen-fixtures|test\/fixtures/,
    'npm test never mutates the checkout by executing fixture helpers');
  assert.match(read('bench/verify-before-update.ps1'),
    /android-tv-stress\.ps1[\s\S]+-Device \$AndroidDevice[\s\S]+-InstallApk/,
    'the full gate installs the APK it just built before emulator stress');
});

test('release contract: Android verification fails fast on device and app preconditions', () => {
  const verify = read('bench/verify-before-update.ps1');
  const stress = read('bench/android-tv-stress.ps1');
  const verifyReadyCall = verify.indexOf('$AndroidDevice = Resolve-ReadyAndroidDevice');
  const firstRepositoryGate = verify.indexOf('Invoke-Gate "git diff whitespace"');
  assert.ok(verifyReadyCall >= 0 && verifyReadyCall < firstRepositoryGate,
    'verify:full checks the Android device before running expensive repository gates');
  assert.match(verify, /sys\.boot_completed/,
    'verify:full requires Android to finish booting');

  const stressReadyCall = stress.indexOf('$Device = Resolve-ReadyAndroidDevice');
  const apkInstall = stress.indexOf('if ($InstallApk)');
  assert.ok(stressReadyCall >= 0 && stressReadyCall < apkInstall,
    'standalone stress checks the exact ADB device before installing or launching');
  assert.match(stress, /reason: 'server-unreachable'[\s\S]+reason: 'app-gate'/,
    'stress distinguishes an unreachable server from an unfinished authentication gate');
  assert.match(stress, /gateLogin[\s\S]+gateSetup[\s\S]+gateProfiles[\s\S]+gatePin/,
    'stress reports actionable login, setup, profile, and PIN preconditions');
  assert.match(stress, /const candidate = document\.getElementById\('chMultiBtn'\);[\s\S]+candidate && candidate\.offsetParent !== null/,
    'stress waits for the Live TV Multiview launcher to become visible, not merely exist in the static shell');
  const bootStop = stress.indexOf("if (!$boot.ok)");
  const pageChurn = stress.indexOf('$page = Invoke-CdpJson');
  assert.ok(bootStop >= 0 && bootStop < pageChurn,
    'failed app preconditions stop stress before page, IPTV, and VOD checks can cascade');
});

test('release contract: local APK publishing cannot ship a debug build or overwrite assets', () => {
  const release = read('bench/cut-apk-release.ps1');
  const workflow = read('.github/workflows/docker.yml');
  assert.match(release, /assembleRelease/);
  assert.doesNotMatch(release, /assembleDebug|debug\.keystore|--clobber/);
  assert.match(release, /already exists; refusing to overwrite immutable assets/);
  assert.match(release, /Publishing requires a completely clean worktree/);
  assert.match(release, /Remote tag \$tag does not point at HEAD/);
  assert.match(release, /No successful main push workflow exists/);
  assert.match(release, /gh run list --branch main --commit \$head --workflow docker\.yml --event push/,
    'the fallback accepts CI only from a push on main for the exact release commit');

  const ciCert = /EXPECTED_CERT_SHA256:\s*([0-9a-f]{64})/.exec(workflow);
  const localCert = /expectedReleaseCertSha256\s*=\s*'([0-9a-f]{64})'/.exec(release);
  assert.ok(ciCert && localCert, 'CI and the local fallback both pin a release certificate');
  assert.strictEqual(localCert[1], ciCert[1], 'the local fallback pins the same production signer as CI');
  assert.match(release, /Get-LatestAndroidBuildTool[\s\S]+ANDROID_HOME[\s\S]+build-tools/,
    'APK inspection uses the Android SDK build-tools, not a PATH shadow');
  assert.match(release, /@\('verify', '--verbose', '--print-certs', \$apk\)/,
    'the fallback requires apksigner verification and certificate output');
  assert.match(release, /certificate SHA-256 digest:[\s\S]+pinned Triboon production signer/,
    'the built APK certificate must match the production fingerprint');
  assert.match(release, /@\('dump', 'badging', \$apk\)[\s\S]+versionName[\s\S]+-cne \$ver/,
    'the APK embedded versionName must match package.json');
  assert.ok(release.indexOf('$certOutput =') < release.indexOf('# --- stage the two published APK names'),
    'APK identity is verified before release aliases are staged');
  assert.match(release, /gh release create \$tag @files --verify-tag/);
});

test('release contract: tag artifacts publish only after provenance and native gates', () => {
  const workflow = read('.github/workflows/docker.yml');
  assert.match(workflow, /sdkmanager "platforms;android-36\.1" "build-tools;36\.1\.0"/,
    'Android CI installs the exact minor platform and build-tools used by compileSdk');
  assert.match(workflow, /test -d "\$ANDROID_HOME\/platforms\/android-36\.1"[\s\S]+test -x "\$ANDROID_HOME\/build-tools\/36\.1\.0\/aapt"/,
    'Android CI validates both locked SDK inputs before Gradle runs');
  assert.match(workflow, /concurrency:[\s\S]+group: triboon-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}[\s\S]+cancel-in-progress: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/,
    'same-ref runs serialize while a newer main push supersedes stale latest-image work');
  assert.match(workflow, /release-preflight:[\s\S]+test "\$TAG" = "v\$version"[\s\S]+git rev-parse origin\/main/,
    'tag preflight binds the exact package version to current main');
  assert.match(workflow, /docker-main:[\s\S]+github\.ref == 'refs\/heads\/main'[\s\S]+type=raw,value=latest/,
    'main publishes only latest/sha images');
  assert.match(workflow, /docker-release:[\s\S]+needs: \[release-preflight, release-apk, release-windows-server\][\s\S]+type=semver/,
    'the semver image waits for every native release artifact');
  assert.match(workflow, /docker-release:[\s\S]+Revalidate current main before publishing the immutable image[\s\S]+git rev-parse origin\/main[\s\S]+GITHUB_SHA[\s\S]+type=semver/,
    'the semver image revalidates main immediately before its publish job');
  assert.match(workflow, /test -x "\$apksigner" \|\|/,
    'APK verification cannot skip apksigner');
  assert.match(workflow, /EXPECTED_CERT_SHA256:\s*c0b1e2d90b443b07fe4ec4001496539aeb810d2bb9bba9a5f1d8781aa7e28d42[\s\S]+certificate SHA-256 digest: \$EXPECTED_CERT_SHA256/,
    'APK verification pins the established release signer');
  assert.match(workflow, /cmp -s "release-assets\/triboon-\$\{TAG\}\.apk" release-assets\/triboon\.apk[\s\S]+mapfile -t actual/,
    'stable/versioned aliases must be identical and the publisher whitelists assets');
  assert.match(workflow, /gh release create "\$TAG" release-assets\/\* --verify-tag[\s\S]+--draft/,
    'the publisher verifies the existing tag and uploads a complete draft before publication');
  assert.match(workflow, /git fetch --force --no-tags origin "refs\/tags\/\$TAG:refs\/tags\/\$TAG"[\s\S]+git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main[\s\S]+git rev-parse "\$TAG\^\{commit\}"[\s\S]+git rev-parse origin\/main[\s\S]+GITHUB_RUN_ID/,
    'the publisher revalidates the remote tag and current main, then only recovers a draft owned by the same workflow run');
  const usesRefs = [...workflow.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(usesRefs.length > 0, 'workflow declares external actions');
  for (const ref of usesRefs) {
    assert.ok(ref.startsWith('./') || /@[0-9a-f]{40}$/.test(ref), `workflow action is pinned by full commit SHA: ${ref}`);
  }
  const nativeClient = workflow.slice(workflow.indexOf('build-windows-client-native:'));
  assert.match(nativeClient, /MPV_BUNDLE_URL: https:\/\/github\.com\/zhongfly\/mpv-winbuild\/releases\/download\/[^\s]+\/mpv-dev-lgpl-x86_64-[^\s]+\.7z/,
    'the experimental libmpv bundle uses an immutable release URL');
  assert.match(nativeClient, /MPV_BUNDLE_SHA256: [0-9a-f]{64}/,
    'the experimental libmpv bundle pins a reviewed SHA-256');
  assert.ok(nativeClient.indexOf('Get-FileHash -Algorithm SHA256') < nativeClient.indexOf('& 7z x -y'),
    'libmpv is checksum-verified before extraction');
  assert.doesNotMatch(nativeClient, /releases\/latest|gh release download/,
    'the experimental native client never resolves a mutable latest release');
  assert.doesNotMatch(workflow, /--clobber/);
});

test('release contract: Docker downloads are pinned, verified, and carry license notices', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM node:24-alpine@sha256:[0-9a-f]{64}$/m, 'base image is pinned by digest');
  assert.match(dockerfile, /^ARG YTDLP_VERSION=\S+$/m);
  assert.match(dockerfile, /^ARG YTDLP_SHA256=[0-9a-f]{64}$/m);
  assert.match(dockerfile, /^ARG ALASS_VERSION=\S+$/m);
  assert.match(dockerfile, /^ARG ALASS_SHA256=[0-9a-f]{64}$/m);
  assert.strictEqual((dockerfile.match(/sha256sum -c -/g) || []).length, 2, 'both downloaded binaries are verified');
  assert.doesNotMatch(dockerfile, /releases\/latest/, 'container build does not consume mutable release URLs');
  assert.match(dockerfile, /COPY LICENSE THIRD-PARTY-NOTICES\.md/);
  assert.match(read('.dockerignore'), /^!THIRD-PARTY-NOTICES\.md$/m,
    'third-party notice is present in the Docker build context');
  assert.match(read('LICENSE'), /^MIT License$/m);
  assert.match(read('THIRD-PARTY-NOTICES.md'), /yt-dlp \| 2026\.07\.04/);

  const windowsInstaller = read('installer/windows/build-installer.ps1');
  assert.match(windowsInstaller, /THIRD-PARTY-NOTICES\.md/,
    'Windows installer carries the repository third-party notice');
});

test('release contract: Windows server artifacts are locked before the tag publisher can run', () => {
  const lock = JSON.parse(read('installer/windows/dependencies.lock.json'));
  const workflow = read('.github/workflows/docker.yml');
  const builder = read('installer/windows/build-installer.ps1');
  const bootstrap = read('installer/windows/install-inno.ps1');

  for (const name of ['node', 'winsw', 'ffmpeg', 'ytDlp', 'alass', 'innoSetup']) {
    assert.match(lock.artifacts[name].sha256, /^[0-9a-f]{64}$/, `${name} is content locked`);
    assert.doesNotMatch(lock.artifacts[name].url, /\/latest(?:\/|$)/i, `${name} URL is immutable`);
  }
  assert.match(builder, /Get-LockedArtifact 'node'/);
  assert.match(builder, /Copy-Item \$lockPath .*windows-dependencies\.lock\.json/);
  assert.match(bootstrap, /Get-AuthenticodeSignature -LiteralPath \$installer/);
  assert.match(bootstrap, /Assert-Sha256 \$compiler \$inno\.compilerSha256/);
  assert.match(workflow, /release-windows-server:[\s\S]+install-inno\.ps1[\s\S]+build-installer\.ps1/);
  assert.doesNotMatch(workflow, /choco install innosetup/i);
});
