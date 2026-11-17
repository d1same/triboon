'use strict';
// Stable watch keys for local library items (brief 99, result 85 design).
//
// Saved progress, watched ticks and Continue Watching used to name a local item by its position in
// the last scan (`local:<lib>:<position>`). Adding, removing or renaming one folder moved every later
// title onto its neighbour's progress. A key now names the item by its place on disk, relative to the
// library folder:
//   - a film in its own folder: the folder (a better copy or a renamed file inside keeps the key);
//   - a loose film file: the file path without its extension;
//   - a show: its folder;
//   - an episode: its show's key plus `:s<N>e<M>`. When two files of one show carry the same season
//     and episode, the first by path keeps that key and the others are keyed by their file path.
// Paths are Unicode NFC with `/` separators and no case folding, so the same library gives the same
// keys on Windows and in Docker, and after the library path itself changes.
//
// A matched title keeps sharing its progress with the Usenet copy and Trakt: its watch key is the
// catalog key (`tmdb:movie:<id>`, `tmdb:tv:<id>`, `tmdb:tv:<id>:s<S>e<E>`). Two show folders of one
// library matched to the same id keep their local keys: their episodes must not merge.

const crypto = require('crypto');
const path = require('path');

const HASH_LEN = 12;
// Positions were at most 25000 (MAX_ITEMS), so a legacy key never has more than 5 digits, while a
// stable id is always 12 hex characters (some of them all digits).
const LEGACY_RE = /^local:([^:]+):(\d{1,5})$/i;
const STABLE_RE = /^local:([^:]+):([0-9a-f]{12})(?::s(\d+)e(\d+))?$/i;

function normRel(rel) {
  return String(rel || '').split(/[\\/]+/).filter(Boolean).join('/').normalize('NFC');
}

// `abs` relative to `root`, or null when it is not inside it.
function relPath(root, abs) {
  if (!root || !abs) return null;
  for (const mod of [path, path.win32, path.posix]) {
    let r;
    try { r = mod.relative(String(root), String(abs)); } catch { continue; }
    if (!r || r.startsWith('..') || mod.isAbsolute(r)) continue;
    return normRel(r);
  }
  return null;
}

function stripExt(rel) {
  return rel.replace(/\.[^./]{1,8}$/, '');
}

function hashOf(kind, rel) {
  return crypto.createHash('sha256').update(`triboon-local-v1\0${kind}\0${rel}`).digest('hex').slice(0, HASH_LEN);
}

function parseLocalKey(key) {
  const s = String(key || '');
  let m = LEGACY_RE.exec(s);
  if (m) return { libId: m[1], legacy: true, pos: parseInt(m[2], 10) };
  m = STABLE_RE.exec(s);
  if (m) {
    const out = { libId: m[1], legacy: false, id: m[2].toLowerCase() };
    if (m[3] !== undefined) { out.season = parseInt(m[3], 10); out.episode = parseInt(m[4], 10); }
    return out;
  }
  return null;
}

function isLegacyPositionKey(key) { return LEGACY_RE.test(String(key || '')); }
function isStableLocalKey(key) { return STABLE_RE.test(String(key || '')); }

// The relative path an item is keyed by: folder of a film in its own folder, file of a loose film,
// folder of a show, file of an episode. `root` is the scanned library folder.
function itemRelPath(root, item) {
  if (!item) return null;
  if (item.kind === 'show') return relPath(root, item.dir);
  const rel = relPath(root, item.file);
  if (!rel) return null;
  return rel;
}

// Gives every item of one scan its stable `key` (and `relPath`). Items are the scan's array, with
// `showIdx` pointing at the show item for an episode. Items whose path is outside `root` get none.
// Also marks `tmdbShared` on show and episode items whose TMDB id another show of this library has.
function assignStableKeys(libId, root, items) {
  const showKey = new Map(); // show idx -> stable show id
  for (const it of items) {
    if (!it) continue;
    delete it.key;
    if (it.kind === 'show') {
      const rel = relPath(root, it.dir);
      if (rel) { it.relPath = rel; const id = hashOf('show', rel); showKey.set(it.idx, id); it.key = `local:${libId}:${id}`; }
    } else if (it.kind !== 'episode') {
      const rel = relPath(root, it.file);
      if (!rel) continue;
      it.relPath = rel;
      // A film in its own folder is the folder; a loose file at the library root is the file.
      it.key = rel.includes('/')
        ? `local:${libId}:${hashOf('dir', rel.slice(0, rel.lastIndexOf('/')))}`
        : `local:${libId}:${hashOf('file', stripExt(rel))}`;
    }
  }
  // Episodes: show key + s/e; a second file with the same s/e in one show is keyed by its own path.
  const eps = items.filter((it) => it && it.kind === 'episode');
  const byPath = (a, b) => String(a._rel || '').localeCompare(String(b._rel || ''), 'en');
  for (const ep of eps) ep._rel = relPath(root, ep.file);
  const taken = new Set();
  for (const ep of [...eps].sort(byPath)) {
    const rel = ep._rel;
    delete ep._rel;
    if (!rel) continue;
    ep.relPath = rel;
    const sid = showKey.get(ep.showIdx);
    const s = parseInt(ep.s, 10);
    const e = parseInt(ep.e, 10);
    const slot = sid && Number.isInteger(s) && Number.isInteger(e) ? `${sid}:s${s}e${e}` : null;
    if (slot && !taken.has(slot)) { taken.add(slot); ep.key = `local:${libId}:${slot}`; }
    else ep.key = `local:${libId}:${hashOf('file', stripExt(rel))}`;
  }
  // Two show folders of this library on one TMDB id: their episodes stay on local keys.
  const showsById = new Map();
  for (const it of items) {
    if (!it || it.kind !== 'show' || !it.tmdbId) continue;
    showsById.set(String(it.tmdbId), (showsById.get(String(it.tmdbId)) || 0) + 1);
  }
  for (const it of items) {
    if (!it || (it.kind !== 'show' && it.kind !== 'episode')) continue;
    if (it.tmdbId && showsById.get(String(it.tmdbId)) > 1) it.tmdbShared = true;
    else delete it.tmdbShared;
  }
  return items;
}

// The key progress is saved under, from the READ-TIME view of an item (unboundLibraryItem: a match
// that fails the read-time check counts as no match).
function watchKeyFor(item) {
  if (!item) return '';
  const id = item.tmdbId ? parseInt(item.tmdbId, 10) : 0;
  if (id > 0) {
    if (item.kind === 'movie') return `tmdb:movie:${id}`;
    if (item.kind === 'show' && !item.tmdbShared) return `tmdb:tv:${id}`;
    if (item.kind === 'episode' && !item.tmdbShared) {
      const s = parseInt(item.s, 10);
      const e = parseInt(item.e, 10);
      if (Number.isInteger(s) && Number.isInteger(e)) return `tmdb:tv:${id}:s${s}e${e}`;
    }
  }
  return item.key || '';
}

module.exports = {
  HASH_LEN, relPath, normRel, hashOf, parseLocalKey, isLegacyPositionKey, isStableLocalKey,
  assignStableKeys, watchKeyFor, itemRelPath,
};
