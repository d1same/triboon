'use strict';

const fs = require('fs');
const path = require('path');

class LibraryDb {
  constructor(dir) {
    this.file = path.join(dir, 'library.sqlite');
    this.db = null;
    this.available = false;
    this._genreCache = new Map(); // libId -> { scannedAt, ids } — genres() is a full table scan; cache it per scan
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(this.file);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS library_meta (
          lib_id TEXT PRIMARY KEY,
          scanned_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS library_items (
          lib_id TEXT NOT NULL,
          idx INTEGER NOT NULL,
          kind TEXT NOT NULL,
          show_idx INTEGER,
          tmdb_id INTEGER,
          season INTEGER,
          episode INTEGER,
          title TEXT,
          title_key TEXT,
          year INTEGER,
          rating REAL,
          added_at INTEGER,
          file TEXT,
          art_file TEXT,
          dir TEXT,
          genres TEXT,
          payload TEXT NOT NULL,
          PRIMARY KEY (lib_id, idx)
        );
        CREATE INDEX IF NOT EXISTS library_items_top_idx
          ON library_items(lib_id, kind, added_at DESC);
        CREATE INDEX IF NOT EXISTS library_items_show_idx
          ON library_items(lib_id, show_idx, season, episode);
        CREATE INDEX IF NOT EXISTS library_items_tmdb_idx
          ON library_items(tmdb_id, kind, season, episode);
        CREATE INDEX IF NOT EXISTS library_items_title_idx
          ON library_items(lib_id, title_key);
      `);
      try { this.db.exec('PRAGMA optimize;'); } catch {}
      this.available = true;
    } catch (e) {
      this.error = e;
      this.db = null;
      this.available = false;
    }
  }

  close() {
    if (!this.db) return;
    this.checkpoint();
    try { this.db.close(); } catch {}
  }

  checkpoint() {
    if (!this.available || !this.db) return false;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;');
      return true;
    } catch (e) {
      this.error = e;
      return false;
    }
  }

  _parsePayload(row) {
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  }

  _genreList(item) {
    return Array.isArray(item && item.genres)
      ? item.genres.map((g) => parseInt(g, 10) || 0).filter(Boolean)
      : [];
  }

  _genreText(item) {
    const ids = this._genreList(item);
    return ids.length ? `|${ids.join('|')}|` : '';
  }

  _titleKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  replaceLibrary(libId, scannedAt, items = []) {
    if (!this.available || !this.db) return false;
    const insert = this.db.prepare(`
      INSERT INTO library_items
      (lib_id, idx, kind, show_idx, tmdb_id, season, episode, title, title_key, year, rating,
       added_at, file, art_file, dir, genres, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('DELETE FROM library_items WHERE lib_id = ?').run(libId);
      this.db.prepare('INSERT OR REPLACE INTO library_meta (lib_id, scanned_at) VALUES (?, ?)')
        .run(libId, scannedAt);
      for (const item of items) {
        insert.run(
          libId,
          Number.isInteger(item.idx) ? item.idx : 0,
          String(item.kind || 'movie'),
          item.showIdx === undefined || item.showIdx === null ? null : parseInt(item.showIdx, 10),
          item.tmdbId ? parseInt(item.tmdbId, 10) : null,
          item.s ? parseInt(item.s, 10) : null,
          item.e ? parseInt(item.e, 10) : null,
          String(item.title || ''),
          this._titleKey(item.title),
          item.year ? parseInt(item.year, 10) : null,
          item.rating === undefined || item.rating === null ? null : Number(item.rating),
          item.addedAt ? Math.round(Number(item.addedAt)) : null,
          item.file || null,
          item.artFile || null,
          item.dir || null,
          this._genreText(item),
          JSON.stringify(item),
        );
      }
      this.db.exec('COMMIT');
      this.checkpoint();
      return true;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.error = e;
      return false;
    }
  }

  deleteLibrary(libId) {
    if (!this.available || !this.db) return false;
    try {
      this.db.prepare('DELETE FROM library_items WHERE lib_id = ?').run(libId);
      this.db.prepare('DELETE FROM library_meta WHERE lib_id = ?').run(libId);
      this._genreCache.delete(libId);
      this.checkpoint();
      return true;
    } catch (e) { this.error = e; return false; }
  }

  item(libId, idx) {
    if (!this.available || !this.db) return null;
    const row = this.db.prepare('SELECT payload FROM library_items WHERE lib_id = ? AND idx = ?')
      .get(libId, parseInt(idx, 10));
    return this._parsePayload(row);
  }

  updateItem(libId, idx, item) {
    if (!this.available || !this.db || !item) return false;
    try {
      this.db.prepare(`
        UPDATE library_items
        SET kind = ?, show_idx = ?, tmdb_id = ?, season = ?, episode = ?, title = ?, title_key = ?,
            year = ?, rating = ?, added_at = ?, file = ?, art_file = ?, dir = ?, genres = ?, payload = ?
        WHERE lib_id = ? AND idx = ?
      `).run(
        String(item.kind || 'movie'),
        item.showIdx === undefined || item.showIdx === null ? null : parseInt(item.showIdx, 10),
        item.tmdbId ? parseInt(item.tmdbId, 10) : null,
        item.s ? parseInt(item.s, 10) : null,
        item.e ? parseInt(item.e, 10) : null,
        String(item.title || ''),
        this._titleKey(item.title),
        item.year ? parseInt(item.year, 10) : null,
        item.rating === undefined || item.rating === null ? null : Number(item.rating),
        item.addedAt ? Math.round(Number(item.addedAt)) : null,
        item.file || null,
        item.artFile || null,
        item.dir || null,
        this._genreText(item),
        JSON.stringify(item),
        libId,
        parseInt(idx, 10),
      );
      this._genreCache.delete(libId); // a match-override can change genres without a rescan
      return true;
    } catch (e) { this.error = e; return false; }
  }

  readLibrary(libId, max = 100000) {
    if (!this.available || !this.db) return null;
    const meta = this.db.prepare('SELECT scanned_at AS scannedAt FROM library_meta WHERE lib_id = ?').get(libId);
    if (!meta) return null;
    const rows = this.db.prepare('SELECT payload FROM library_items WHERE lib_id = ? ORDER BY idx LIMIT ?').all(libId, max);
    return { scannedAt: meta.scannedAt, items: rows.map((r) => this._parsePayload(r)).filter(Boolean) };
  }

  genres(libId) {
    if (!this.available || !this.db) return [];
    const rows = this.db.prepare(`
      SELECT genres FROM library_items
      WHERE lib_id = ? AND kind != 'episode' AND genres IS NOT NULL
    `).all(libId);
    const ids = new Set();
    for (const row of rows) {
      for (const part of String(row.genres || '').split('|')) {
        const id = parseInt(part, 10) || 0;
        if (id) ids.add(id);
      }
    }
    return [...ids].sort((a, b) => a - b);
  }

  // genres() full-scans every non-episode row. The set only changes on a (re)scan, so cache it per
  // (libId, scannedAt) — a browse page on a 20K library was paying that scan on EVERY flip.
  genresCached(libId, scannedAt) {
    const hit = this._genreCache.get(libId);
    if (hit && hit.scannedAt === scannedAt) return hit.ids;
    const ids = this.genres(libId);
    this._genreCache.set(libId, { scannedAt, ids });
    return ids;
  }

  page(libId, { offset = 0, limit = 72, sort = 'added.desc', genre = 0, showIdx = null } = {}) {
    if (!this.available || !this.db) return null;
    const meta = this.db.prepare('SELECT scanned_at AS scannedAt FROM library_meta WHERE lib_id = ?').get(libId);
    if (!meta) return null;
    offset = Math.max(0, parseInt(offset, 10) || 0);
    limit = Math.max(1, Math.min(500, parseInt(limit, 10) || 72));
    genre = parseInt(genre, 10) || 0;
    let where = 'lib_id = ?';
    const args = [libId];
    let order = 'added_at DESC, idx ASC';
    let show = null;
    if (showIdx !== null && Number.isFinite(showIdx)) {
      show = this.item(libId, showIdx);
      where += " AND kind = 'episode' AND show_idx = ?";
      args.push(showIdx);
      order = 'season ASC, episode ASC, title_key ASC';
    } else {
      where += " AND kind != 'episode'";
      if (genre) {
        where += ' AND genres LIKE ?';
        args.push(`%|${genre}|%`);
      }
      if (sort === 'title.asc') order = 'title_key ASC, idx ASC';
      else if (sort === 'year.desc') order = 'year DESC, title_key ASC';
      else if (sort === 'rating.desc') order = 'rating DESC, title_key ASC';
    }
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE ${where}`).get(...args);
    const rows = this.db.prepare(`
      SELECT payload FROM library_items
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);
    const items = rows.map((r) => this._parsePayload(r)).filter(Boolean);
    return {
      scannedAt: meta.scannedAt,
      offset,
      limit,
      total: totalRow ? totalRow.n : items.length,
      hasMore: offset + items.length < ((totalRow && totalRow.n) || 0),
      genres: showIdx === null ? this.genresCached(libId, meta.scannedAt) : [],
      show,
      items,
    };
  }

  lookup(keys = [], allowedLibIds = []) {
    if (!this.available || !this.db || !keys.length || !allowedLibIds.length) return {};
    const out = {};
    const libs = new Set(allowedLibIds.map(String));
    const allForMovie = this.db.prepare("SELECT lib_id, payload FROM library_items WHERE tmdb_id = ? AND kind = 'movie' ORDER BY added_at DESC LIMIT 10");
    const allForEpisode = this.db.prepare("SELECT lib_id, payload FROM library_items WHERE tmdb_id = ? AND kind = 'episode' AND season = ? AND episode = ? ORDER BY added_at DESC LIMIT 10");
    for (const key of keys.map(String)) {
      let rows = [];
      let m = /^tmdb:movie:(\d+)$/i.exec(key);
      if (m) rows = allForMovie.all(parseInt(m[1], 10));
      else {
        m = /^tmdb:tv:(\d+):s(\d+)e(\d+)$/i.exec(key);
        if (m) rows = allForEpisode.all(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
      }
      const row = rows.find((r) => libs.has(String(r.lib_id)));
      const item = this._parsePayload(row);
      if (item) out[key] = { libId: row.lib_id, item };
    }
    return out;
  }
}

module.exports = { LibraryDb };
