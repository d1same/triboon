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

test('installer hardens the ProgramData data-dir ACL so secret.json is not world-readable', () => {
  assert.match(iss, /icacls/);
  assert.match(iss, /\/inheritance:r/);             // drop the inherited BUILTIN\Users read
  assert.match(iss, /S-1-5-18/);                    // grant SYSTEM (the service account)
  assert.match(iss, /S-1-5-32-544/);                // and Administrators only
  // The additive SYSTEM/Admins grant must run BEFORE the /inheritance:r strip, so a momentarily-locked
  // file can't be orphaned with no usable ACE (that locked the service out of secret.json → Error 1067).
  const harden = iss.slice(iss.indexOf('procedure HardenDataDir'), iss.indexOf('procedure OpenFirewall'));
  // Match the exact icacls COMMANDS (not substrings that also appear in comments): the additive grant
  // (Pass 1) must precede the inheritance-strip command (Pass 2).
  assert.ok(harden.indexOf('/grant "*S-1-5-18') >= 0 && harden.indexOf('/grant "*S-1-5-18') < harden.indexOf('/inheritance:r /grant:r'),
    'HardenDataDir grants SYSTEM Full additively BEFORE stripping inheritance (no ACL orphaning / 1067)');
});

test('build script integrity-verifies every bundled binary (not just Node)', () => {
  assert.match(ps1, /function Assert-Sha256/);
  // WinSW + alass are pinned to immutable-release hashes; a changed binary must break the build.
  assert.ok(ps1.includes('05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'), 'WinSW hash must be pinned');
  assert.ok(ps1.includes('e81a72f97f592910e909a2352d6b8c0de0801c51ac1383bad4ebf3f2ecdd2fd8'), 'alass hash must be pinned');
  // ffmpeg + yt-dlp verified against provider checksums fetched fresh.
  assert.match(ps1, /\.sha256/);
  assert.match(ps1, /SHA2-256SUMS/);
  // The alass archive ships alass-cli.exe (there is no alass.exe) - the glob must match it.
  assert.match(ps1, /alass-cli\.exe/);
});
