'use strict';
// Saved RAR/ZIP map for one NZB body. The next Play skips the header walk.
// The key is a hash of the NZB text. The password is never stored here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function mapKey(nzbXml) {
  return crypto.createHash('sha256').update(String(nzbXml || '')).digest('hex');
}

// What the saved map was chosen FOR (E2-2). One season-pack NZB holds many episodes, and the map
// records the one inner file that was picked. Same validity rule as mountIdentity in
// pipeline.js: an episode needs integer s >= 0 and integer e > 0. Null = a plain request.
function mapScope(opts = {}) {
  const we = opts && opts.wantedEpisode;
  const s = Number(we && we.s), e = Number(we && we.e);
  const ep = Number.isInteger(s) && s >= 0 && Number.isInteger(e) && e > 0 ? `s${s}e${e}` : null;
  return { ep, audiobook: !!(opts && opts.audiobook) };
}

// A plain request keeps exactly mapKey(nzbXml), so every saved movie map stays valid. An episode
// or audiobook request gets its own key; old records (no scope) are never found for those.
function scopedMapKey(nzbXml, opts = {}) {
  const { ep, audiobook } = mapScope(opts);
  if (!ep && !audiobook) return mapKey(nzbXml);
  return crypto.createHash('sha256')
    .update(String(nzbXml || '')).update(`\u0000|${ep || '-'}|a${audiobook ? 1 : 0}`)
    .digest('hex');
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

module.exports = { MountMapStore, mapKey, mapScope, scopedMapKey, getMountMap, configureMountMap };
