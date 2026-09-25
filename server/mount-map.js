'use strict';
// Saved RAR/ZIP map for one NZB body. The next Play skips the header walk.
// The key is a hash of the NZB text. The password is never stored here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function mapKey(nzbXml) {
  return crypto.createHash('sha256').update(String(nzbXml || '')).digest('hex');
}

class MountMapStore {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();
  }

  keyFor(nzbXml) {
    return mapKey(nzbXml);
  }

  get(nzbXmlOrKey) {
    const key = /^[a-f0-9]{64}$/.test(String(nzbXmlOrKey || '')) ? nzbXmlOrKey : mapKey(nzbXmlOrKey);
    if (!key || !this.dir) return null;
    if (this.mem.has(key)) return this.mem.get(key);
    try {
      const raw = fs.readFileSync(path.join(this.dir, key), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.volumes)) return null;
      if (parsed.password) return null;
      this.mem.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  put(nzbXmlOrKey, record) {
    if (!this.dir || !record || record.password) return;
    const key = /^[a-f0-9]{64}$/.test(String(nzbXmlOrKey || '')) ? nzbXmlOrKey : mapKey(nzbXmlOrKey);
    if (!key) return;
    const clean = { ...record };
    delete clean.password;
    this.mem.set(key, clean);
    fs.promises.mkdir(this.dir, { recursive: true }).then(() => {
      const dest = path.join(this.dir, key);
      const tmp = dest + '.tmp';
      return fs.promises.writeFile(tmp, JSON.stringify(clean)).then(() => fs.promises.rename(tmp, dest));
    }).catch(() => {});
  }
}

let active = null;

function getMountMap() {
  return active;
}

function configureMountMap(dir) {
  active = dir ? new MountMapStore(dir) : null;
  return active;
}

module.exports = { MountMapStore, mapKey, getMountMap, configureMountMap };
