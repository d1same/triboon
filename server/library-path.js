'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// Mapped drive letters (M:) belong to the interactive user session. The Windows
// service runs as LocalSystem, so it cannot see that letter and a scan saves
// "0 items". The UNC share is the same folder, and the service can read that.
const uncCache = new Map();

function remotePathFromReg(key) {
  const out = execFileSync('reg', ['query', key, '/v', 'RemotePath'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = /RemotePath\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im.exec(out);
  return m ? m[1].replace(/[\\/]+$/, '') : null;
}

function userHiveSids() {
  try {
    const out = execFileSync('reg', ['query', 'HKU'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^HKEY_USERS\\(S-1-5-21-[0-9-]+)$/i.exec(line.trim());
      if (m) sids.push(m[1]);
    }
    return sids;
  } catch {
    return [];
  }
}

function windowsMappedUnc(letter) {
  if (process.platform !== 'win32') return null;
  const drive = String(letter || '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(drive)) return null;
  const hit = uncCache.get(drive);
  if (hit && Date.now() - hit.at < 60000) return hit.unc;
  let unc = null;
  const keys = [`HKCU\\Network\\${drive}`];
  // The service's own HKCU is empty. The signed-in user's map lives under HKU.
  for (const sid of userHiveSids()) keys.push(`HKU\\${sid}\\Network\\${drive}`);
  for (const key of keys) {
    try {
      unc = remotePathFromReg(key);
      if (unc) break;
    } catch { /* this hive has no map for the letter */ }
  }
  uncCache.set(drive, { at: Date.now(), unc });
  return unc;
}

function resolveLibraryPath(raw) {
  const p = String(raw || '').trim();
  if (!p) return p;
  const drive = /^([A-Za-z]):([\\/].*)?$/.exec(p);
  if (!drive) return p;
  const uncRoot = windowsMappedUnc(drive[1]);
  if (!uncRoot) return p;
  const rest = String(drive[2] || '').replace(/\//g, '\\');
  const unc = uncRoot + rest;
  // Use the share when it is really there. A service can have the drive letter
  // and still see an empty folder, which is how a full library saved as 0 items.
  try { if (fs.existsSync(unc)) return unc; } catch { /* share down */ }
  try { if (fs.existsSync(p)) return p; } catch { /* letter missing */ }
  return unc;
}

function existingMediaPath(raw) {
  const resolved = resolveLibraryPath(raw);
  try { if (resolved && fs.existsSync(resolved)) return resolved; } catch { /* missing */ }
  return raw;
}

module.exports = { windowsMappedUnc, resolveLibraryPath, existingMediaPath };
