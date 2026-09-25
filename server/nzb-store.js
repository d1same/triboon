'use strict';
// Durable NZB XML. Tiny. The filename is a hash, never the grab URL.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nzbKey(url) {
  return crypto.createHash('sha256').update(String(url || '')).digest('hex');
}

class NzbStore {
  constructor(dir, { maxFiles = 200, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
    this.index = new Map();
    this.bytes = 0;
    this._loaded = false;
    this._loading = null;
  }

  async get(url) {
    const key = nzbKey(url);
    if (!key || !this.dir) return null;
    await this._ensure();
    const rec = this.index.get(key);
    if (!rec) return null;
    try {
      const xml = await fs.promises.readFile(path.join(this.dir, key), 'utf8');
      if (!/<file\b/i.test(xml)) return null;
      rec.at = Date.now();
      return xml;
    } catch {
      this.index.delete(key);
      return null;
    }
  }

  put(url, xml) {
    if (!this.dir || !url || !xml || !/<file\b/i.test(xml)) return;
    const key = nzbKey(url);
    this._ensure().then(() => this._write(key, xml)).catch(() => {});
  }

  async _write(key, xml) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const dest = path.join(this.dir, key);
    const tmp = dest + '.tmp';
    await fs.promises.writeFile(tmp, xml);
    await fs.promises.rename(tmp, dest);
    const prior = this.index.get(key);
    if (prior) this.bytes -= prior.bytes;
    const bytes = Buffer.byteLength(xml);
    this.index.set(key, { bytes, at: Date.now() });
    this.bytes += bytes;
    await this._evict();
  }

  async _evict() {
    while ((this.index.size > this.maxFiles || this.bytes > this.maxBytes) && this.index.size > 1) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const [key, rec] of this.index) {
        if ((rec.at || 0) < oldestAt) {
          oldestAt = rec.at || 0;
          oldest = key;
        }
      }
      if (!oldest) break;
      const rec = this.index.get(oldest);
      this.index.delete(oldest);
      this.bytes = Math.max(0, this.bytes - (rec.bytes || 0));
      try { await fs.promises.rm(path.join(this.dir, oldest), { force: true }); } catch {}
    }
  }

  async _ensure() {
    if (this._loaded) return;
    if (!this._loading) {
      this._loading = fs.promises.mkdir(this.dir, { recursive: true }).then(async () => {
        const names = await fs.promises.readdir(this.dir);
        for (const name of names) {
          if (!/^[a-f0-9]{64}$/.test(name)) continue;
          try {
            const st = await fs.promises.stat(path.join(this.dir, name));
            this.index.set(name, { bytes: st.size, at: st.mtimeMs });
            this.bytes += st.size;
          } catch {}
        }
        this._loaded = true;
      }).finally(() => { this._loading = null; });
    }
    await this._loading;
  }
}

let active = null;

function getNzbStore() {
  return active;
}

function configureNzbStore(dir) {
  active = dir ? new NzbStore(dir) : null;
  return active;
}

module.exports = { NzbStore, nzbKey, getNzbStore, configureNzbStore };
