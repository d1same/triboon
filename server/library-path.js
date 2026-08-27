'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// Mapped drive letters (M:) belong to the interactive user session. An elevated
// Node process or the Windows service often cannot see them, so a library scan
// walks nothing and reports "0 items". The UNC share still works.
function windowsMappedUnc(letter) {
  if (process.platform !== 'win32') return null;
  const drive = String(letter || '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(drive)) return null;
  try {
    const out = execFileSync('reg', ['query', `HKCU\\Network\\${drive}`, '/v', 'RemotePath'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    const m = /RemotePath\s+REG_SZ\s+(\S+)/i.exec(out);
    return m ? m[1].replace(/[\\/]+$/, '') : null;
  } catch {
    return null;
  }
}

function resolveLibraryPath(raw) {
  const p = String(raw || '').trim();
  if (!p) return p;
  try { if (fs.existsSync(p)) return p; } catch { /* letter missing */ }
  const drive = /^([A-Za-z]):([\\/].*)?$/.exec(p);
  if (!drive) return p;
  const uncRoot = windowsMappedUnc(drive[1]);
  if (!uncRoot) return p;
  const rest = String(drive[2] || '').replace(/\//g, '\\');
  return uncRoot + rest;
}

function existingMediaPath(raw) {
  const resolved = resolveLibraryPath(raw);
  try { if (resolved && fs.existsSync(resolved)) return resolved; } catch { /* missing */ }
  return raw;
}

module.exports = { windowsMappedUnc, resolveLibraryPath, existingMediaPath };
