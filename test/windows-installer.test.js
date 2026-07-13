'use strict';
// Config-drift guards for the Windows server installer (installer/windows/).
// These are static-file assertions, not a runtime test: they fail loudly if the packaged service
// definition stops matching what the server actually reads, or if the installer loses one of its
// security/data-safety guarantees. The real install-time end-to-end is verified by hand per release
// (see installer/windows/README.md) because it needs an elevated Windows box + Inno Setup.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const xml = read('installer/windows/triboon-service.xml');
const iss = read('installer/windows/Triboon.iss');
const ps1 = read('installer/windows/build-installer.ps1');
const innoBootstrap = read('installer/windows/install-inno.ps1');
const workflow = read('.github/workflows/docker.yml');
const dependencyLock = JSON.parse(read('installer/windows/dependencies.lock.json'));
const transcode = read('server/transcode.js');
const ytmusic = read('server/ytmusic.js');

test('service xml wires every sidecar env var the server actually reads', () => {
  // The server checks each of these env vars before falling back to PATH. If someone renames one
  // in the server, this fails so the installer never ships a service that can't find its binaries.
  for (const v of ['FFMPEG_PATH', 'FFPROBE_PATH', 'ALASS_PATH']) {
    assert.ok(transcode.includes(v), `transcode.js should still read ${v}`);
    assert.ok(xml.includes(`name="${v}"`), `service xml should set ${v}`);
  }
  assert.ok(ytmusic.includes('YTDLP_PATH'), 'ytmusic.js should still read YTDLP_PATH');
  assert.ok(xml.includes('name="YTDLP_PATH"'), 'service xml should set YTDLP_PATH');
});

test('service xml runs the bundled node against the server entry, with data under ProgramData', () => {
  assert.match(xml, /<executable>%BASE%\\node\.exe<\/executable>/);
  assert.match(xml, /server\\index\.js/);
  // Data MUST live under ProgramData (preserved), never under the wiped Program Files app dir.
  assert.match(xml, /name="TRIBOON_DATA" value="%ProgramData%\\Triboon\\data"/);
  assert.match(xml, /<startmode>Automatic<\/startmode>/);
  assert.match(xml, /<onfailure action="restart"/);
  // The service id is what sc.exe stop/delete targets in the .iss upgrade path — keep it in sync.
  assert.match(xml, /<id>Triboon<\/id>/);
});

test('installer elevates, scopes the firewall to the LAN, and preserves user data', () => {
  assert.match(iss, /PrivilegesRequired=admin/);
  // Firewall: private+domain only. A self-hosted LAN server must never open the public profile.
  assert.match(iss, /profile=private,domain/);
  assert.ok(!/profile=any|profile=public/.test(iss), 'firewall rule must not include the public profile');
  // Keep-data-on-uninstall.
  assert.match(iss, /\{commonappdata\}\\Triboon\\data".*uninsneveruninstall/);
  assert.ok(!/\[UninstallDelete\]/.test(iss), 'must not force-delete the data dir via [UninstallDelete]');
});

test('installer stops the service before replacing files, and cleans up on uninstall', () => {
  // Stopping the locking service must happen in PrepareToInstall (before [Files]), not [Run].
  assert.match(iss, /function PrepareToInstall/);
  assert.match(iss, /SERVICE_NAME = 'Triboon'/);
  assert.match(iss, /'stop ' \+ SERVICE_NAME/);
  assert.match(iss, /'delete ' \+ SERVICE_NAME/);
  // Uninstall removes the service and the firewall rule (unique RunOnceIds).
  assert.match(iss, /Parameters: "stop".*RunOnceId/s);
  assert.match(iss, /Parameters: "uninstall".*RunOnceId/s);
  assert.match(iss, /delete rule name=""Triboon Server""/);
  // A fixed AppId is what makes upgrades replace (not duplicate) the prior install.
  assert.match(iss, /^AppId=\{\{[0-9A-Fa-f-]+\}/m);
});

test('installer treats upgrade vs fresh install correctly and never touches user data', () => {
  // Fresh install short-circuits the whole stop/clean path (no prior service). Everything below the
  // guard is the UPGRADE path, and none of it references the ProgramData data dir.
  assert.match(iss, /if not ServiceExists\(\) then exit;\s*\/\/ FRESH INSTALL/);
  // Owner ask #1: on upgrade, stop the SERVICE *and* the tray before files are replaced.
  assert.match(iss, /procedure StopTray\(\)/);
  assert.match(iss, /triboon-tray/);                 // tray stopped by command-line match (not a blanket kill)
  assert.match(iss, /StopTray\(\);/);                // called from PrepareToInstall (upgrade)
  assert.match(iss, /usUninstall then StopTray/);    // and on uninstall
  // Owner ask #1: clean the Program Files payload so stale code can't linger — but ONLY the code dirs.
  assert.match(iss, /procedure CleanAppPayload\(\)/);
  assert.match(iss, /DelTree\(ExpandConstant\('\{app\}\\server'\)/);
  assert.match(iss, /DelTree\(ExpandConstant\('\{app\}\\web'\)/);
  assert.match(iss, /DelTree\(ExpandConstant\('\{app\}\\bin'\)/);
  assert.ok(!/DelTree\(ExpandConstant\('\{app\}\\data'/.test(iss) && !/DelTree\([^)]*commonappdata/.test(iss),
    'the clean-install step must NEVER delete the data dir (ProgramData) or a stray {app}\\data');
  assert.match(iss, /if not ServiceExists\(\) then begin CleanAppPayload\(\); exit; end;/,
    'payload is cleaned only after the service is confirmed gone (node.exe unlocked)');
  // Owner ask #2 (data loss): the installed service config gets the LITERAL ProgramData path written
  // in, so data placement never depends on WinSW/env expanding %ProgramData%.
  assert.match(iss, /procedure WriteServiceDataPath\(\)/);
  assert.match(iss, /StringChangeEx\(content, '%ProgramData%\\Triboon\\data', ExpandConstant\('\{commonappdata\}\\Triboon\\data'\)/);
  assert.match(iss, /WriteServiceDataPath\(\);/);    // called in CurStepChanged before the service registers
});

test('installer registers the service with exit-code checks + a marked-for-delete poll', () => {
  // Service register/start moved out of exit-code-blind [Run] into [Code] with real checks.
  assert.match(iss, /procedure CurStepChanged/);
  assert.match(iss, /RaiseException/);              // hard-fail if `install` fails (no silent success)
  assert.match(iss, /ServiceRunning/);              // confirm it actually reached RUNNING after start
  assert.match(iss, /1060/);                        // poll until the old service is truly gone (not just marked)
});

test('installer ACL protects secrets without recursively orphaning the LocalSystem service', () => {
  assert.match(iss, /procedure RunIcacls/);
  assert.match(iss, /if rc <> 0 then\s+RaiseException/,
    'every ACL phase is checked before the service is registered');

  const recover = iss.indexOf('/inheritance:e /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C /Q');
  const rootReset = iss.indexOf(`" /reset /Q', 'reset the Triboon root ACL'`);
  const rootGrant = iss.indexOf('" /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /Q');
  const rootProtect = iss.indexOf(`" /inheritance:r /Q', 'remove inherited local-user access from the Triboon root'`);
  const childReset = iss.indexOf(`" /reset /T /C /Q', 'reset child ACLs from the protected root'`);
  const childEnable = iss.indexOf(`" /inheritance:e /T /C /Q', 're-enable child inheritance'`);

  for (const [name, index] of Object.entries({ recover, rootReset, rootGrant, rootProtect, childReset, childEnable })) {
    assert.ok(index >= 0, `ACL phase is present: ${name}`);
  }
  assert.ok(recover < rootReset && rootReset < rootGrant && rootGrant < rootProtect &&
    rootProtect < childReset && childReset < childEnable,
    'ACL recovery happens before root protection, then children inherit from the protected root');
  assert.doesNotMatch(iss, /RunIcacls\([^\r\n]*\/inheritance:r[^\r\n]*\/T/,
    'inheritance removal is root-only; recursive removal can orphan locked files');
  assert.match(iss, /children := dir \+ '\\\*'/,
    'reset and inheritance-enable operations target children, not the protected root');
});

test('Windows build dependencies use exact HTTPS URLs and reviewed SHA-256 locks', () => {
  assert.strictEqual(dependencyLock.schemaVersion, 1);
  const names = ['node', 'winsw', 'ffmpeg', 'ytDlp', 'alass', 'innoSetup'];
  for (const name of names) {
    const artifact = dependencyLock.artifacts[name];
    assert.ok(artifact, `${name} is present in the lock`);
    assert.match(artifact.version, /\S+/, `${name} has an exact version`);
    assert.match(artifact.url, /^https:\/\//, `${name} uses HTTPS`);
    assert.doesNotMatch(artifact.url, /\/latest(?:\/|$)/i, `${name} does not use a moving latest URL`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `${name} has a SHA-256`);
    assert.strictEqual(path.basename(artifact.fileName), artifact.fileName, `${name} cache name is a safe leaf`);
  }
  assert.match(dependencyLock.artifacts.node.version, /^v24\./, 'the bundled Node runtime stays on Node 24 LTS');
  assert.match(dependencyLock.artifacts.node.url, /\/dist\/v24\.\d+\.\d+\/node-v24\.\d+\.\d+-win-x64\.zip$/);
  assert.match(dependencyLock.artifacts.ffmpeg.url, /\/packages\/ffmpeg-\d+\.\d+(?:\.\d+)?-essentials_build\.zip$/);
  assert.match(dependencyLock.artifacts.ytDlp.url, /\/releases\/download\/\d{4}\.\d{2}\.\d{2}\/yt-dlp\.exe$/);
  assert.match(dependencyLock.artifacts.innoSetup.compilerSha256, /^[0-9a-f]{64}$/);
  assert.match(dependencyLock.artifacts.innoSetup.url,
    /github\.com\/jrsoftware\/issrc\/releases\/download\/is-6_7_3\/innosetup-6\.7\.3\.exe$/);
});

test('build script consumes only the dependency lock and verifies every bundled binary', () => {
  assert.match(ps1, /dependencies\.lock\.json/);
  assert.match(ps1, /function Assert-Sha256/);
  assert.match(ps1, /Get-LockedArtifact 'node'/);
  assert.match(ps1, /Get-LockedArtifact 'ffmpeg'/);
  assert.match(ps1, /Get-LockedArtifact 'ytDlp'/);
  assert.doesNotMatch(ps1, /dist\/index\.json|releases\/latest|SHA2-256SUMS|Get-Text/,
    'builds never resolve a version or checksum from the network');
  assert.match(ps1, /\.partial/);
  assert.match(ps1, /Assert-Sha256 \$partial \$expectedHash/);
  assert.match(ps1, /Move-Item -LiteralPath \$partial -Destination \$outFile/,
    'only verified partial downloads enter the cache');
  assert.match(ps1, /windows-dependencies\.lock\.json/,
    'the exact dependency provenance ships with the installer');
  // The alass archive ships alass-cli.exe (there is no alass.exe) - the glob must match it.
  assert.match(ps1, /alass-cli\.exe/);
  assert.match(ps1, /throw 'alass-cli\.exe not found/,
    'a requested sidecar cannot silently disappear from a release build');
});

test('release CI installs and validates the locked Inno Setup compiler without Chocolatey resolution', () => {
  assert.match(innoBootstrap, /dependencies\.lock\.json/);
  assert.match(innoBootstrap, /Assert-Sha256 \$partial \$inno\.sha256/);
  assert.match(innoBootstrap, /Get-AuthenticodeSignature -LiteralPath \$installer/);
  assert.ok(innoBootstrap.indexOf('Get-AuthenticodeSignature') < innoBootstrap.indexOf('Start-Process'),
    'the installer signature is verified before execution');
  assert.match(innoBootstrap, /Assert-Sha256 \$compiler \$inno\.compilerSha256/,
    'the installed compiler is re-verified');
  assert.match(workflow, /Install locked Inno Setup[\s\S]+installer\/windows\/install-inno\.ps1/);
  assert.doesNotMatch(workflow, /choco install innosetup/i,
    'release CI does not ask a package manager to resolve Inno Setup');
  assert.match(ps1, /ISCC version mismatch/,
    'the packager refuses a compiler version different from the lock');
});
